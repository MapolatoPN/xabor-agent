// Suite P0: aislamiento de pedidos, pagos pendientes y Clip por negocio.
// Reproduce el incidente real (2 de agosto de 2026): una conversación de
// WhatsApp de Alora generó una comanda y un enlace de pago atribuidos al
// negocio Nonna Maye. Causas raíz confirmadas y cubiertas aquí:
//   1. registrarPedido() (orderManager.js) ya no admite ningún negocio por
//      defecto -- TENANT_CONTEXT_REQUIRED si falta negocioId, para
//      cualquier canal.
//   2. clip-api.js resuelve credenciales EXCLUSIVAMENTE por negocio
//      (integraciones_canal/integraciones_canal_credenciales, canal='pagos'
//      proveedor='clip') -- nunca una cuenta global, nunca la de otro negocio.
//   3. getPagoPendiente/setPagoPendiente/clearPagoPendiente y las consultas
//      de pedidos por teléfono exigen negocioId y verifican dueño --
//      clientes.telefono sigue siendo una PK global, así que sin esto un
//      mismo número real compartido entre negocios podía filtrar datos.
//
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... PANEL_SECRET=...
//      SESSION_SECRET=... ADMIN_PASSWORD=... node test/fase-p0-aislamiento-pedidos.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
//
// No llama a Clip real en ningún momento: solo se ejercita hasta la capa
// de resolución de credenciales (obtenerCredencialesClipDescifradas) y el
// camino de error ClipNoConfiguradoError, que nunca llegan a la red.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4099';

const {
  pool, guardarPedidoActivo, setPagoPendiente, getPagoPendiente, clearPagoPendiente,
  obtenerPedidosActivosPorTelefono, obtenerUltimoPedidoEntregadoPorTelefono,
  guardarLinkPago, confirmarPagoPedido, obtenerPagosPendientesConLink,
} = await import('../src/services/database.js');
const { registrarPedido, obtenerPedidoPorId } = await import('../src/orders/orderManager.js');
const { obtenerCredencialesClipDescifradas, guardarCredencialesClip, TenantContextRequiredError } = await import('../src/services/integracionesService.js');
const { crearLinkDePago, consultarEstadoPago, ClipNoConfiguradoError } = await import('../src/services/clip-api.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(categoria, nombre, fn) {
  try { await fn(); console.log(`  OK  [${categoria}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${categoria}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${categoria}] ${nombre}: ${e.message}`); }
}

// Aislamiento entre suites persistidas: limpia restos de corridas previas
// en los negocios sembrados, para que el orden de ejecución nunca importe.
const TEL_COMPARTIDO = '5218781119001';
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = ANY($1) AND folio LIKE 'XABP0%'`, [[SEED.negocioA, SEED.negocioB, SEED.nonnaMayeId]]);
await pool.query(`DELETE FROM clientes WHERE telefono = $1`, [TEL_COMPARTIDO]);
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1) AND canal='pagos' AND proveedor='clip')`, [[SEED.negocioA, SEED.negocioB, SEED.nonnaMayeId]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'pagos' AND proveedor = 'clip' AND negocio_id = ANY($1)`, [[SEED.negocioA, SEED.negocioB, SEED.nonnaMayeId]]);

const cookieSuperadmin = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.superadminUsuarioId, negocioId: SEED.negocioA, rol: 'admin' }))}`;
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo JSON */ }
  return { status: r.status, body: json };
}

// ═══════════ 1. registrarPedido: fail-closed universal (causa raíz #1) ═══════════
await t('PEDIDO', 'registrarPedido sin negocioId (canal whatsapp) -> TENANT_CONTEXT_REQUIRED, no se persiste', async () => {
  const orden = { cliente: { nombre: 'Cliente Test', telefono: TEL_COMPARTIDO }, total: 100, items: [] };
  // registrarPedido es async (Fase 2 de la corrección de carrera) -- un
  // throw dentro de una función async siempre produce una promesa
  // rechazada, nunca un throw síncrono, así que la aserción debe ser
  // assert.rejects (no assert.throws con un callback síncrono).
  await assert.rejects(() => registrarPedido(orden, 'whatsapp'), /TENANT_CONTEXT_REQUIRED/);
});
await t('PEDIDO', 'registrarPedido sin negocioId (canal voz) -> TENANT_CONTEXT_REQUIRED', async () => {
  const orden = { cliente: { nombre: 'Cliente Test', telefono: TEL_COMPARTIDO }, total: 100, items: [] };
  await assert.rejects(() => registrarPedido(orden, 'voz'), /TENANT_CONTEXT_REQUIRED/);
});
await t('PEDIDO', 'registrarPedido con negocioId real -> pedido.negocioId = ese negocio, nunca otro', async () => {
  const orden = { cliente: { nombre: 'Cliente Alora', telefono: TEL_COMPARTIDO }, total: 250, items: [], negocioId: SEED.negocioA };
  const pedido = await registrarPedido(orden, 'whatsapp');
  assert.strictEqual(pedido.negocioId, SEED.negocioA);
  assert.notStrictEqual(pedido.negocioId, SEED.nonnaMayeId);
});

// ═══════════ 2. obtenerPedidoPorId: verificación de dueño (defensa en profundidad) ═══════════
await t('PEDIDO', 'obtenerPedidoPorId con negocioId equivocado -> undefined (idéntico a inexistente)', async () => {
  const ordenA = { cliente: { nombre: 'Cliente Alora', telefono: TEL_COMPARTIDO }, total: 300, items: [], negocioId: SEED.negocioA };
  const pedidoA = await registrarPedido(ordenA, 'whatsapp');
  assert.strictEqual(obtenerPedidoPorId(pedidoA.id, SEED.nonnaMayeId), undefined);
  assert.strictEqual(obtenerPedidoPorId(pedidoA.id, SEED.negocioA)?.id, pedidoA.id);
});
await t('PEDIDO', 'obtenerPedidoPorId sin negocioId (descubrimiento legítimo, p. ej. webhook) sigue funcionando', async () => {
  const ordenA = { cliente: { nombre: 'Cliente Alora', telefono: TEL_COMPARTIDO }, total: 300, items: [], negocioId: SEED.negocioA };
  const pedidoA = await registrarPedido(ordenA, 'whatsapp');
  const encontrado = obtenerPedidoPorId(pedidoA.id);
  assert.strictEqual(encontrado.negocioId, SEED.negocioA);
});

// ═══════════ 3. Pago pendiente: aislamiento por negocio (mismo teléfono, dos negocios) ═══════════
await t('PAGO-PENDIENTE', 'setPagoPendiente sin negocioId -> rechazado, no escribe', async () => {
  const ok = await setPagoPendiente(TEL_COMPARTIDO, 'XABP0001');
  assert.strictEqual(ok, false);
});
await t('PAGO-PENDIENTE', 'Nonna Maye fija un pago pendiente para un teléfono; Alora (mismo teléfono) NUNCA lo ve', async () => {
  const okNonna = await setPagoPendiente(TEL_COMPARTIDO, 'XABP0777', SEED.nonnaMayeId);
  assert.strictEqual(okNonna, true);
  const vistoPorAlora = await getPagoPendiente(TEL_COMPARTIDO, SEED.negocioA);
  assert.strictEqual(vistoPorAlora, null, 'Alora nunca debe ver el pago pendiente de Nonna Maye para el mismo teléfono');
  const vistoPorNonna = await getPagoPendiente(TEL_COMPARTIDO, SEED.nonnaMayeId);
  assert.strictEqual(vistoPorNonna, 'XABP0777');
});
await t('PAGO-PENDIENTE', 'Alora nunca puede limpiar el pago pendiente de Nonna Maye para el mismo teléfono', async () => {
  const limpiado = await clearPagoPendiente(TEL_COMPARTIDO, SEED.negocioA);
  assert.strictEqual(limpiado, false);
  const sigueAhi = await getPagoPendiente(TEL_COMPARTIDO, SEED.nonnaMayeId);
  assert.strictEqual(sigueAhi, 'XABP0777', 'el pago pendiente de Nonna Maye debe seguir intacto');
  await clearPagoPendiente(TEL_COMPARTIDO, SEED.nonnaMayeId); // limpieza real, por su dueño
});

// ═══════════ 4. Pedidos activos / entregados por teléfono: aislamiento ═══════════
await t('CONSULTA-TELEFONO', 'pedidos activos: mismo teléfono en Nonna Maye y Alora -> cada negocio ve solo el suyo', async () => {
  await guardarPedidoActivo({ id: 'XABP0801', estado: 'nuevo', cliente: { telefono: TEL_COMPARTIDO }, total: 111 }, SEED.nonnaMayeId);
  await guardarPedidoActivo({ id: 'XABP0802', estado: 'nuevo', cliente: { telefono: TEL_COMPARTIDO }, total: 222 }, SEED.negocioA);

  const paraNonna = await obtenerPedidosActivosPorTelefono(TEL_COMPARTIDO, SEED.nonnaMayeId);
  const paraAlora = await obtenerPedidosActivosPorTelefono(TEL_COMPARTIDO, SEED.negocioA);

  assert.ok(paraNonna.some(p => p.folio === 'XABP0801'));
  assert.ok(!paraNonna.some(p => p.folio === 'XABP0802'), 'Nonna Maye nunca debe ver el pedido activo de Alora');
  assert.ok(paraAlora.some(p => p.folio === 'XABP0802'));
  assert.ok(!paraAlora.some(p => p.folio === 'XABP0801'), 'Alora nunca debe ver el pedido activo de Nonna Maye');
});
await t('CONSULTA-TELEFONO', 'obtenerPedidosActivosPorTelefono sin negocioId -> [] (nunca la lista completa)', async () => {
  const r = await obtenerPedidosActivosPorTelefono(TEL_COMPARTIDO);
  assert.deepStrictEqual(r, []);
});
await t('CONSULTA-TELEFONO', 'último pedido entregado: aislado por negocio', async () => {
  await guardarPedidoActivo({ id: 'XABP0803', estado: 'entregado', cliente: { telefono: TEL_COMPARTIDO }, total: 333 }, SEED.nonnaMayeId);
  const paraAlora = await obtenerUltimoPedidoEntregadoPorTelefono(TEL_COMPARTIDO, SEED.negocioA);
  assert.strictEqual(paraAlora, null, 'Alora no debe heredar el historial de entregados de Nonna Maye');
  const paraNonna = await obtenerUltimoPedidoEntregadoPorTelefono(TEL_COMPARTIDO, SEED.nonnaMayeId);
  assert.strictEqual(paraNonna?.folio, 'XABP0803');
});

// ═══════════ 5. Folio guessing: defensa en profundidad ═══════════
await t('FOLIO-GUESSING', 'confirmarPagoPedido con negocioId de otro negocio -> no confirma el folio ajeno', async () => {
  await guardarPedidoActivo({ id: 'XABP0900', estado: 'nuevo', forma_pago: 'enlace de pago', cliente: { telefono: TEL_COMPARTIDO }, total: 500 }, SEED.negocioA);
  const okAjeno = await confirmarPagoPedido('XABP0900', SEED.nonnaMayeId);
  assert.strictEqual(okAjeno, false);
  const { rows } = await pool.query(`SELECT datos->>'pago_confirmado' AS pc FROM pedidos_activos WHERE folio = 'XABP0900'`);
  assert.notStrictEqual(rows[0].pc, 'true');
  const okReal = await confirmarPagoPedido('XABP0900', SEED.negocioA);
  assert.strictEqual(okReal, true);
});
await t('FOLIO-GUESSING', 'guardarLinkPago con negocioId de otro negocio -> no escribe en el folio ajeno', async () => {
  await guardarPedidoActivo({ id: 'XABP0901', estado: 'nuevo', cliente: { telefono: TEL_COMPARTIDO }, total: 600 }, SEED.negocioA);
  const okAjeno = await guardarLinkPago('XABP0901', SEED.nonnaMayeId, 'link-ajeno-simulado');
  assert.strictEqual(okAjeno, false);
  const { rows } = await pool.query(`SELECT datos->>'clip_link_id' AS lid FROM pedidos_activos WHERE folio = 'XABP0901'`);
  assert.strictEqual(rows[0].lid, null);
});
await t('FOLIO-GUESSING', 'obtenerPagosPendientesConLink incluye negocio_id -- nunca ambiguo entre negocios', async () => {
  await guardarPedidoActivo({ id: 'XABP0902', estado: 'nuevo', forma_pago: 'enlace de pago', cliente: { telefono: TEL_COMPARTIDO }, total: 700 }, SEED.negocioA);
  await guardarLinkPago('XABP0902', SEED.negocioA, 'link-real-simulado');
  const pendientes = await obtenerPagosPendientesConLink();
  const fila = pendientes.find(p => p.folio === 'XABP0902');
  assert.ok(fila);
  assert.strictEqual(fila.negocio_id, SEED.negocioA);
});
await t('CLIP', 'llamador real (reconciliarPagosPendientes en server.js): negocio_id salido de obtenerPagosPendientesConLink -- nunca escrito a mano en la prueba -- se propaga a consultarEstadoPago sin TenantContextRequiredError', async () => {
  // A diferencia de las pruebas de arriba, que llaman al servicio con un
  // negocioId elegido por la prueba, aquí el valor viene de la MISMA
  // consulta SQL que usa el job real de reconciliación (server.js,
  // reconciliarPagosPendientes) -- se ejercita el punto exacto de contacto
  // entre ese llamador real y clip-api.js. Alora todavía no tiene Clip
  // configurado en este punto de la suite (se configura más abajo, sección
  // HTTP-CLIP), así que el resultado correcto es null, sin tocar la red.
  const pendientes = await obtenerPagosPendientesConLink();
  const fila = pendientes.find(p => p.folio === 'XABP0902');
  assert.ok(fila, 'fixture de la prueba anterior');
  const estado = await consultarEstadoPago(fila.clip_link_id, fila.negocio_id);
  assert.strictEqual(estado, null);
});

// ═══════════ 6. Clip por negocio (causa raíz #2) ═══════════
// Corrección de contrato (seguimiento del incidente): negocioId
// ausente/inválido/vacío en cualquier operación de Clip debe LANZAR un
// error tipado (TenantContextRequiredError, código TENANT_CONTEXT_REQUIRED)
// -- nunca null silencioso, nunca fallback. null solo es válido cuando
// negocioId es una cadena real pero el negocio no tiene Clip configurado.
await t('CLIP', 'obtenerCredencialesClipDescifradas(undefined) -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => obtenerCredencialesClipDescifradas(undefined),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('CLIP', 'obtenerCredencialesClipDescifradas(null) -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => obtenerCredencialesClipDescifradas(null),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('CLIP', "obtenerCredencialesClipDescifradas('') -> TenantContextRequiredError tipado", async () => {
  await assert.rejects(
    () => obtenerCredencialesClipDescifradas(''),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('CLIP', 'obtenerCredencialesClipDescifradas(negocio inexistente) -> null (CLIP_NO_CONFIGURADO en el llamador, nunca error de sesión)', async () => {
  const r = await obtenerCredencialesClipDescifradas('00000000-0000-0000-0000-000000000000');
  assert.strictEqual(r, null);
});
await t('CLIP', 'guardarCredencialesClip sin negocioId -> TenantContextRequiredError tipado', async () => {
  await assert.rejects(
    () => guardarCredencialesClip(undefined, 'k', 's', SEED.superadminUsuarioId),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('CLIP', 'crearLinkDePago sin negocioId -> TenantContextRequiredError tipado, lanza antes de tocar la red', async () => {
  await assert.rejects(
    () => crearLinkDePago({ pedidoId: 'X', total: 100 }),
    (e) => e instanceof TenantContextRequiredError && e.code === 'TENANT_CONTEXT_REQUIRED'
  );
});
await t('CLIP', 'Alora sin Clip configurado -> ClipNoConfiguradoError (fail-closed, nunca usa otra cuenta)', async () => {
  await assert.rejects(
    () => crearLinkDePago({ negocioId: SEED.negocioA, pedidoId: 'XABP1000', total: 100 }),
    (e) => e instanceof ClipNoConfiguradoError && e.code === 'CLIP_NO_CONFIGURADO'
  );
});
await t('CLIP', 'consultarEstadoPago sin Clip configurado -> null (nunca lanza, nunca usa otra cuenta)', async () => {
  const r = await consultarEstadoPago('cualquier-link-id', SEED.negocioA);
  assert.strictEqual(r, null);
});
await t('CLIP', 'Nonna Maye guarda su Clip -> Alora sigue sin Clip configurado', async () => {
  await guardarCredencialesClip(SEED.nonnaMayeId, 'NONNA_CLIP_KEY_TEST', 'NONNA_CLIP_SECRET_TEST', SEED.superadminUsuarioId);
  const credNonna = await obtenerCredencialesClipDescifradas(SEED.nonnaMayeId);
  assert.strictEqual(credNonna.apiKey, 'NONNA_CLIP_KEY_TEST');
  const credAlora = await obtenerCredencialesClipDescifradas(SEED.negocioA);
  assert.strictEqual(credAlora, null, 'Alora nunca debe heredar las credenciales Clip de Nonna Maye');
});
await t('CLIP', 'Alora guarda su propio Clip -> credenciales de A y Nonna Maye quedan separadas y correctas', async () => {
  await guardarCredencialesClip(SEED.negocioA, 'ALORA_CLIP_KEY_TEST', 'ALORA_CLIP_SECRET_TEST', SEED.superadminUsuarioId);
  const credAlora = await obtenerCredencialesClipDescifradas(SEED.negocioA);
  const credNonna = await obtenerCredencialesClipDescifradas(SEED.nonnaMayeId);
  assert.strictEqual(credAlora.apiKey, 'ALORA_CLIP_KEY_TEST');
  assert.strictEqual(credNonna.apiKey, 'NONNA_CLIP_KEY_TEST');
  assert.notStrictEqual(credAlora.apiKey, credNonna.apiKey);
  assert.notStrictEqual(credAlora.apiSecret, credNonna.apiSecret);
});
await t('CLIP', 'negocio Demo (sin ninguna configuración) -> ClipNoConfiguradoError, nunca hereda de A ni de Nonna Maye', async () => {
  await assert.rejects(
    () => crearLinkDePago({ negocioId: SEED.negocioB, pedidoId: 'XABP1001', total: 50 }),
    (e) => e instanceof ClipNoConfiguradoError
  );
});

// ═══════════ 7. HTTP: ruta de Superadmin para guardar credenciales Clip ═══════════
{
  const srv = await arrancarServidor({ PORT: PUERTO });
  try {
    await t('HTTP-CLIP', 'sin sesión -> 401', async () => {
      const r = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/integraciones/clip`, { method: 'PUT', body: { apiKey: 'x', apiSecret: 'y' } });
      assert.strictEqual(r.status, 401);
    });
    await t('HTTP-CLIP', 'superadmin sin apiSecret -> 400', async () => {
      const r = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/integraciones/clip`, { cookie: cookieSuperadmin, method: 'PUT', body: { apiKey: 'x' } });
      assert.strictEqual(r.status, 400);
    });
    await t('HTTP-CLIP', 'superadmin guarda Clip de Alora -> 200, GET /integraciones nunca expone las credenciales', async () => {
      const r = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/integraciones/clip`, { cookie: cookieSuperadmin, method: 'PUT', body: { apiKey: 'HTTP_TEST_KEY', apiSecret: 'HTTP_TEST_SECRET' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.estado, 'activo');
      const lista = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/integraciones`, { cookie: cookieSuperadmin });
      const texto = JSON.stringify(lista.body);
      assert.ok(!texto.includes('HTTP_TEST_KEY'));
      assert.ok(!texto.includes('HTTP_TEST_SECRET'));
      assert.ok(!/access_token_cifrado|token_iv|token_auth_tag/i.test(texto));
      const clipRow = lista.body.integraciones.find(i => i.canal === 'pagos' && i.proveedor === 'clip');
      assert.ok(clipRow, 'la integración de Clip debe aparecer en el listado general');
      assert.strictEqual(clipRow.estado, 'activo');
    });
  } finally { srv.detener(); }
}

// ─── Resumen ───────────────────────────────────────────────────────────────
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas > 0) {
  console.log('\nDetalle de fallos:');
  for (const f of fallos) console.log(`  - ${f}`);
  process.exit(1);
}
