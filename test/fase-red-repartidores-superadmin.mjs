// Red de Repartidores — Módulo Superadmin (Fase A completa + Fase B mínima).
//
// Cubre:
//   - Roster: Superadmin ve todos los negocios, negocio-admin solo el suyo
//     (aislamiento en la ruta PATCH /api/admin/repartidores/:id/estado),
//     operador (staff) recibe 403 (requireAdminSeguro ya exige rol >= admin,
//     sin código nuevo para esto -- se verifica que sigue así).
//   - cambiarEstadoRepartidor: única función que sincroniza estado+activo;
//     disponible->activo=true, pausado/suspendido/baja->activo=false;
//     "baja" nunca borra el historial en notificaciones_repartidor.
//   - "ocupado" es derivado (disponible + pedido activo asignado), nunca
//     persistido.
//   - Duplicados: mismo teléfono normalizado (normalizarTelefonoMX),
//     distinto formato (con/sin prefijo 521).
//   - Servicios de reparto (Fase B mínima): estado derivado
//     (buscando/asignado/entregado), Rappi SIEMPRE excluido de la lista
//     principal (canal='rappi' Y rappi_order_id con canal mal etiquetado),
//     visible solo en la sección separada "externas"; entregado/cancelado
//     sí deben verse en el historial.
//
// Uso: mismas env vars que el resto de la batería. Requiere
// aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4193';

const { crearTokenSesion } = await import('../src/services/session.js');
const {
  pool, registrarRepartidor, asignarRepartidor, cambiarEstadoRepartidor,
} = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════ Setup ═══════════
await fijarModulo(SEED.negocioA, 'pos', 'activo');
await fijarModulo(SEED.negocioB, 'pos', 'activo');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;

const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');

// Repartidores de prueba, uno por negocio, teléfonos únicos por corrida
// para no chocar con filas de otras suites/corridas previas sobre la misma DB.
const sufijo = Date.now().toString().slice(-6);
const repA = await registrarRepartidor(`RR Repartidor A ${sufijo}`, `87811${sufijo.slice(0, 5)}`, SEED.negocioA);
const repB = await registrarRepartidor(`RR Repartidor B ${sufijo}`, `87822${sufijo.slice(0, 5)}`, SEED.negocioB);
assert.ok(repA && repB, 'setup: no se pudieron crear los repartidores de prueba');

// ═══════════ ROSTER — visibilidad y permisos ═══════════
await t('ROSTER', 'SUPERADMIN-VE-TODOS-LOS-NEGOCIOS', async () => {
  const r = await api(base, '/api/superadmin/red-repartidores/roster?pageSize=500', { cookie: cookieSuperadmin });
  assert.equal(r.status, 200);
  const ids = r.body.filas.map(f => f.id);
  assert.ok(ids.includes(repA.id), 'debe incluir al repartidor de negocioA');
  assert.ok(ids.includes(repB.id), 'debe incluir al repartidor de negocioB');
});

await t('ROSTER', 'SUPERADMIN-FILTRA-POR-NEGOCIO', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/roster?negocioId=${SEED.negocioA}&pageSize=500`, { cookie: cookieSuperadmin });
  const ids = r.body.filas.map(f => f.id);
  assert.ok(ids.includes(repA.id));
  assert.ok(!ids.includes(repB.id), 'no debe incluir repartidores de otro negocio al filtrar');
});

await t('ROSTER', 'SIN-SESION-401', async () => {
  const r = await api(base, '/api/superadmin/red-repartidores/roster');
  assert.equal(r.status, 401);
});

await t('ROSTER', 'ADMIN-DE-NEGOCIO-NO-ES-SUPERADMIN-403', async () => {
  const r = await api(base, '/api/superadmin/red-repartidores/roster', { cookie: cookieAdminA });
  assert.equal(r.status, 403);
});

// ═══════════ cambiarEstadoRepartidor — sincronización atómica ═══════════
await t('ESTADO', 'DISPONIBLE-ACTIVA', async () => {
  await cambiarEstadoRepartidor(repA.id, 'pausado', {});
  const actualizado = await cambiarEstadoRepartidor(repA.id, 'disponible', {});
  assert.equal(actualizado.estado, 'disponible');
  assert.equal(actualizado.activo, true);
});

for (const estado of ['pausado', 'suspendido', 'baja']) {
  await t('ESTADO', `${estado.toUpperCase()}-DESACTIVA`, async () => {
    const actualizado = await cambiarEstadoRepartidor(repA.id, estado, {});
    assert.equal(actualizado.estado, estado);
    assert.equal(actualizado.activo, false);
  });
}
// Dejarlo disponible de nuevo para el resto de las pruebas.
await cambiarEstadoRepartidor(repA.id, 'disponible', {});

await t('ESTADO', 'ESTADO-INVALIDO-RECHAZADO', async () => {
  const resultado = await cambiarEstadoRepartidor(repA.id, 'inventado', {});
  assert.equal(resultado, null);
  const r = await api(base, `/api/superadmin/red-repartidores/roster/${repA.id}/estado`, { cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'inventado' } });
  assert.equal(r.status, 400);
});

await t('ESTADO', 'NEGOCIO-ADMIN-AISLAMIENTO-NO-PUEDE-TOCAR-OTRO-NEGOCIO', async () => {
  const r = await api(base, `/api/admin/repartidores/${repB.id}/estado`, { cookie: cookieAdminA, method: 'PATCH', body: { estado: 'pausado' } });
  assert.equal(r.status, 404, 'un admin de negocioA no debe poder cambiar el estado de un repartidor de negocioB');
  const { rows: [fila] } = await pool.query('SELECT estado FROM repartidores WHERE id = $1', [repB.id]);
  assert.notEqual(fila.estado, 'pausado', 'el estado de repB no debió cambiar');
});

await t('ESTADO', 'NEGOCIO-ADMIN-SI-PUEDE-CAMBIAR-SU-PROPIO-REPARTIDOR', async () => {
  const r = await api(base, `/api/admin/repartidores/${repA.id}/estado`, { cookie: cookieAdminA, method: 'PATCH', body: { estado: 'pausado' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.estado, 'pausado');
  assert.equal(r.body.activo, false);
  await cambiarEstadoRepartidor(repA.id, 'disponible', {}); // dejar como estaba
});

await t('ESTADO', 'OPERADOR-STAFF-NO-ADMINISTRA-403', async () => {
  const r = await api(base, `/api/admin/repartidores/${repA.id}/estado`, { cookie: cookieStaffA, method: 'PATCH', body: { estado: 'pausado' } });
  assert.equal(r.status, 403);
});

await t('ESTADO', 'BAJA-CONSERVA-HISTORIAL-NUNCA-BORRA-FILA', async () => {
  await pool.query(
    `INSERT INTO notificaciones_repartidor (negocio_id, pedido_folio, repartidor_id, canal, estado)
     VALUES ($1, $2, $3, 'plantilla', 'entregado')`,
    [SEED.negocioA, `RR-HIST-${sufijo}`, repA.id]
  );
  await cambiarEstadoRepartidor(repA.id, 'baja', {});
  const { rows } = await pool.query('SELECT * FROM notificaciones_repartidor WHERE repartidor_id = $1', [repA.id]);
  assert.ok(rows.length >= 1, 'la fila de historial debe seguir existiendo tras dar de baja');
  const { rows: [fila] } = await pool.query('SELECT * FROM repartidores WHERE id = $1', [repA.id]);
  assert.ok(fila, 'el registro del repartidor debe seguir existiendo (nunca DELETE)');
  assert.equal(fila.estado, 'baja');
  assert.equal(fila.activo, false);
  await cambiarEstadoRepartidor(repA.id, 'disponible', {}); // restaurar
});

// ═══════════ "Ocupado" derivado ═══════════
await t('DERIVADO', 'OCUPADO-ES-DISPONIBLE-CON-PEDIDO-ACTIVO-ASIGNADO', async () => {
  const rCrear = await api(base, '/test/pedido', { cookie: cookieAdminA, method: 'POST' });
  const folio = rCrear.body.pedido.id;
  await esperar(1500);
  const ok = await asignarRepartidor(folio, repA.id, repA.nombre, SEED.negocioA);
  assert.ok(ok, 'asignarRepartidor debe tener éxito');
  const r = await api(base, `/api/superadmin/red-repartidores/roster?negocioId=${SEED.negocioA}&pageSize=500`, { cookie: cookieSuperadmin });
  const fila = r.body.filas.find(f => f.id === repA.id);
  assert.equal(fila.estado_operativo, 'ocupado', 'con un pedido activo asignado, el roster debe mostrar "ocupado" sin haberlo persistido');
  const { rows: [crudo] } = await pool.query('SELECT estado FROM repartidores WHERE id = $1', [repA.id]);
  assert.equal(crudo.estado, 'disponible', 'el campo estado en la tabla nunca debe guardar "ocupado"');
  await pool.query(`UPDATE pedidos_activos SET estado = 'entregado' WHERE folio = $1`, [folio]);
});

// ═══════════ Duplicados ═══════════
await t('DUPLICADOS', 'MISMO-TELEFONO-DISTINTO-PREFIJO-SE-AGRUPA', async () => {
  // registrarRepartidor() ya normaliza el prefijo 521 en escritura (función
  // normalizarTelefono interna de database.js), así que llamarlo dos veces
  // con y sin prefijo cae en el mismo ON CONFLICT (telefono) y actualiza la
  // MISMA fila -- no reproduce el escenario real de duplicados. Ese
  // escenario (documentado en utils/telefono.js) viene de datos legado
  // insertados antes de esa normalización, con el prefijo intacto en la
  // columna cruda -- se simula aquí con un INSERT directo.
  // 10 dígitos exactos (878 + sufijo de 6 dígitos + relleno a 10) -- con
  // menos de 10 dígitos normalizarTelefonoMX devuelve null y la fila queda
  // fuera de cualquier grupo (comportamiento correcto de la función, el bug
  // real estaba aquí: un teléfono de prueba mal armado).
  const telSinPrefijo = `878${sufijo}0`;
  const telConPrefijo = `521${telSinPrefijo}`;
  const { rows: [dupA] } = await pool.query(
    `INSERT INTO repartidores (nombre, telefono, token, negocio_id) VALUES ($1,$2,$3,$4) RETURNING *`,
    [`RR Duplicado 1 ${sufijo}`, telSinPrefijo, `tok1${sufijo}`, SEED.negocioA]
  );
  const { rows: [dupB] } = await pool.query(
    `INSERT INTO repartidores (nombre, telefono, token, negocio_id) VALUES ($1,$2,$3,$4) RETURNING *`,
    [`RR Duplicado 2 ${sufijo}`, telConPrefijo, `tok2${sufijo}`, SEED.negocioA]
  );
  assert.ok(dupA && dupB);
  const r = await api(base, `/api/superadmin/red-repartidores/duplicados?negocioId=${SEED.negocioA}`, { cookie: cookieSuperadmin });
  assert.equal(r.status, 200);
  const grupo = r.body.find(g => g.filas.some(f => f.id === dupA.id));
  assert.ok(grupo, 'debe existir un grupo de duplicados que incluya al primer repartidor insertado');
  const idsGrupo = grupo.filas.map(f => f.id);
  assert.ok(idsGrupo.includes(dupB.id), 'el grupo debe incluir también al segundo (mismo teléfono normalizado)');

  const rRoster = await api(base, `/api/superadmin/red-repartidores/roster?negocioId=${SEED.negocioA}&soloDuplicados=true&pageSize=500`, { cookie: cookieSuperadmin });
  const idsRoster = rRoster.body.filas.map(f => f.id);
  assert.ok(idsRoster.includes(dupA.id) && idsRoster.includes(dupB.id), 'el filtro soloDuplicados debe mostrar ambas filas');
  assert.ok(!idsRoster.includes(repB.id), 'un repartidor sin duplicado no debe aparecer con soloDuplicados=true');
});

// ═══════════ Filtros de roster ═══════════
await t('ROSTER', 'FILTRO-POR-ESTADO', async () => {
  await cambiarEstadoRepartidor(repB.id, 'suspendido', {});
  const r = await api(base, `/api/superadmin/red-repartidores/roster?negocioId=${SEED.negocioB}&estado=suspendido`, { cookie: cookieSuperadmin });
  assert.ok(r.body.filas.every(f => f.estado === 'suspendido'));
  assert.ok(r.body.filas.some(f => f.id === repB.id));
  await cambiarEstadoRepartidor(repB.id, 'disponible', {});
});

await t('ROSTER', 'BUSQUEDA-POR-NOMBRE', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/roster?busqueda=${encodeURIComponent('RR Repartidor A')}`, { cookie: cookieSuperadmin });
  assert.ok(r.body.filas.some(f => f.id === repA.id));
});

// ═══════════ Servicios de reparto (Fase B mínima) ═══════════
let folioBuscando, folioAsignado, folioEntregado, folioRappi, folioRappiMalEtiquetado;

await t('SERVICIOS', 'SETUP-PEDIDOS-DE-PRUEBA', async () => {
  const crear = async () => {
    const r = await api(base, '/test/pedido', { cookie: cookieAdminA, method: 'POST' });
    return r.body.pedido.id;
  };
  folioBuscando = await crear();
  folioAsignado = await crear();
  folioEntregado = await crear();
  await esperar(1500);
  const ok = await asignarRepartidor(folioAsignado, repA.id, repA.nombre, SEED.negocioA);
  assert.ok(ok);
  await pool.query(`UPDATE pedidos_activos SET estado = 'entregado' WHERE folio = $1`, [folioEntregado]);

  // Pedidos de Rappi -- insertados directamente (no hay endpoint de prueba
  // para el webhook de Rappi en este arnés), uno con canal='rappi' y otro
  // con canal mal etiquetado pero rappi_order_id presente (defensa en
  // profundidad, mismo criterio que esPedidoElegibleParaRedRepartidores).
  folioRappi = `RR-RAPPI-${sufijo}`;
  folioRappiMalEtiquetado = `RR-RAPPIMAL-${sufijo}`;
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1, 'nuevo', $2, $3)`,
    [folioRappi, JSON.stringify({ modalidad: 'entrega a domicilio', canal: 'rappi', total: 200 }), SEED.negocioA]
  );
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1, 'nuevo', $2, $3)`,
    [folioRappiMalEtiquetado, JSON.stringify({ modalidad: 'entrega a domicilio', canal: 'test', rappi_order_id: 'RAPPI-999', total: 150 }), SEED.negocioA]
  );
});

await t('SERVICIOS', 'BUSCANDO-SIN-ASIGNAR-SIN-INTENTOS', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/servicios?negocioId=${SEED.negocioA}&pageSize=500`, { cookie: cookieSuperadmin });
  const s = r.body.redXabor.find(x => x.folio === folioBuscando);
  assert.ok(s, 'el pedido debe aparecer en la lista de la Red Xabor');
  assert.equal(s.estadoDerivado, 'buscando');
});

await t('SERVICIOS', 'ASIGNADO-MUESTRA-REPARTIDOR', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/servicios?negocioId=${SEED.negocioA}&pageSize=500`, { cookie: cookieSuperadmin });
  const s = r.body.redXabor.find(x => x.folio === folioAsignado);
  assert.ok(s);
  assert.equal(s.estadoDerivado, 'asignado');
  assert.equal(s.repartidorAsignado.id, String(repA.id));
});

await t('SERVICIOS', 'ENTREGADO-VISIBLE-EN-HISTORIAL', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/servicios?negocioId=${SEED.negocioA}&pageSize=500`, { cookie: cookieSuperadmin });
  const s = r.body.redXabor.find(x => x.folio === folioEntregado);
  assert.ok(s, 'un pedido entregado debe seguir apareciendo en el historial, no desaparecer');
  assert.equal(s.estadoDerivado, 'entregado');
});

await t('SERVICIOS', 'RAPPI-NUNCA-EN-LA-LISTA-PRINCIPAL', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/servicios?negocioId=${SEED.negocioA}&pageSize=500`, { cookie: cookieSuperadmin });
  assert.ok(!r.body.redXabor.some(x => x.folio === folioRappi), 'canal=rappi debe estar excluido de la Red Xabor');
  const externa = r.body.externas.find(x => x.folio === folioRappi);
  assert.ok(externa, 'debe aparecer en la sección de plataformas externas');
  assert.match(externa.etiqueta, /Rappi/);
});

await t('SERVICIOS', 'RAPPI-CANAL-MAL-ETIQUETADO-IGUAL-EXCLUIDO', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/servicios?negocioId=${SEED.negocioA}&pageSize=500`, { cookie: cookieSuperadmin });
  assert.ok(!r.body.redXabor.some(x => x.folio === folioRappiMalEtiquetado), 'rappi_order_id presente debe excluir aunque el canal esté mal etiquetado (defensa en profundidad)');
  assert.ok(r.body.externas.some(x => x.folio === folioRappiMalEtiquetado));
});

await t('SERVICIOS', 'FILTRO-POR-NEGOCIO-AISLA', async () => {
  const r = await api(base, `/api/superadmin/red-repartidores/servicios?negocioId=${SEED.negocioB}&pageSize=500`, { cookie: cookieSuperadmin });
  assert.ok(!r.body.redXabor.some(x => x.folio === folioBuscando), 'no debe traer pedidos de negocioA al filtrar por negocioB');
});

await t('SERVICIOS', 'DETALLE-SERVICIO-INCLUYE-NOTIFICADOS', async () => {
  await pool.query(
    `INSERT INTO notificaciones_repartidor (negocio_id, pedido_folio, repartidor_id, canal, estado, token_usado_at)
     VALUES ($1, $2, $3, 'plantilla', 'entregado', NOW())`,
    [SEED.negocioA, folioAsignado, repA.id]
  );
  const r = await api(base, `/api/superadmin/red-repartidores/servicios/${folioAsignado}`, { cookie: cookieSuperadmin });
  assert.equal(r.status, 200);
  assert.equal(r.body.folio, folioAsignado);
  assert.ok(r.body.notificados.length >= 1);
  const n = r.body.notificados.find(x => x.repartidorId === repA.id);
  assert.ok(n);
  assert.equal(n.acepto, true);
  assert.ok(n.telefonoOculto.startsWith('...'), 'el teléfono debe mostrarse parcialmente oculto');
});

await t('SERVICIOS', 'SIN-SESION-401', async () => {
  const r = await api(base, '/api/superadmin/red-repartidores/servicios');
  assert.equal(r.status, 401);
});

// ═══════════ Reporte ═══════════
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas > 0) { console.log('\nFallos:'); fallos.forEach(f => console.log(' -', f)); }
await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
