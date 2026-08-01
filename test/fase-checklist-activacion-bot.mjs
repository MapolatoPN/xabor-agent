// Suite persistida: checklist de activación del bot de WhatsApp (Fase 5
// del encargo "preparar Xabor para primeros clientes"). Cubre que los
// ítems automáticos se derivan correctamente de datos YA existentes
// (integración, configuracion.nombre/horario/reglas_atencion, menú), que
// los 3 ítems sin campo existente quedan como confirmación manual sobre
// negocios.checklist (reutilizando el endpoint PATCH ya existente), y que
// el chequeo es asesor (gatea el botón del panel) sin bloquear la API de
// PATCH bot-whatsapp -- decisión explícita para no arriesgar dejar a un
// negocio ya operando (con datos anteriores a este checklist) sin poder
// reactivar su propio bot.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4097';

const { crearTokenSesion } = await import('../src/services/session.js');
const {
  pool, obtenerChecklistActivacionBot, actualizarConfiguracion, obtenerBotWhatsappActivoNegocio,
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
const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');
const rutaChecklist = (id) => `/api/superadmin/negocios/${id}/checklist-activacion-bot`;

// Negocio C (whatsapp no_contratado en el seed): sin ninguna configuración.
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE, checklist = '{}' WHERE id = $1`, [SEED.negocioC]);
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1`, [SEED.negocioC]);
await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1`, [SEED.negocioC]);

await t('DB', 'negocio recién sembrado sin configuración -> todos los automáticos en false, listoParaActivar false', async () => {
  const r = await obtenerChecklistActivacionBot(SEED.negocioC);
  assert.strictEqual(r.listoParaActivar, false);
  assert.strictEqual(r.automaticos.nombre_negocio, false);
  assert.strictEqual(r.automaticos.metodos_pago, false);
  assert.strictEqual(r.automaticos.modalidades_entrega, false);
  assert.strictEqual(r.automaticos.reglas_operativas, false);
  assert.strictEqual(r.automaticos.bot_apagado, true); // recién apagado por el UPDATE de arriba
});

await t('DB', 'negocio inexistente -> null (nunca lanza)', async () => {
  const r = await obtenerChecklistActivacionBot('00000000-0000-0000-0000-000000000000');
  assert.strictEqual(r, null);
});

await t('DB', 'completar nombre/horario/reglas_atencion + tener menú -> automáticos en true', async () => {
  await actualizarConfiguracion({
    nombre: 'Negocio Prueba Checklist',
    horario: 'Lun-Dom 9:00-21:00',
    reglas_atencion: JSON.stringify({
      horarios: { lunes: { abierto: true, apertura: '09:00', cierre: '21:00' } },
      pedidos: { modalidades: ['recoger en tienda'], pago_aceptado: ['efectivo'] },
    }),
  }, SEED.negocioC);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden, activa) VALUES ($1,'Categoría prueba',1,TRUE) RETURNING id`, [SEED.negocioC]
  );
  await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, orden) VALUES ($1,$2,'Producto prueba',50,1)`, [SEED.negocioC, cat.id]
  );
  const r = await obtenerChecklistActivacionBot(SEED.negocioC);
  assert.strictEqual(r.automaticos.nombre_negocio, true);
  assert.strictEqual(r.automaticos.horarios, true);
  assert.strictEqual(r.automaticos.productos_servicios, true);
  assert.strictEqual(r.automaticos.metodos_pago, true);
  assert.strictEqual(r.automaticos.modalidades_entrega, true);
  assert.strictEqual(r.automaticos.reglas_operativas, true);
  // Sin integración conectada ni confirmaciones manuales -> sigue sin poder activarse
  assert.strictEqual(r.automaticos.integracion_conectada, false);
  assert.strictEqual(r.listoParaActivar, false);
});

{
  const srv = await arrancarServidor({ PORT: PUERTO });
  try {
    await t('PERM', 'sin sesión -> 401', async () => {
      const r = await api(srv.base, rutaChecklist(SEED.negocioA));
      assert.strictEqual(r.status, 401);
    });
    await t('PERM', 'admin normal (no superadmin) -> 403', async () => {
      const r = await api(srv.base, rutaChecklist(SEED.negocioA), { cookie: cookieAdminA });
      assert.strictEqual(r.status, 403);
    });
    await t('PERM', 'staff -> 403', async () => {
      const r = await api(srv.base, rutaChecklist(SEED.negocioA), { cookie: cookieStaffA });
      assert.strictEqual(r.status, 403);
    });
    await t('PERM', 'superadmin -> 200 con el objeto completo', async () => {
      const r = await api(srv.base, rutaChecklist(SEED.negocioC), { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 200);
      assert.ok('automaticos' in r.body && 'manuales' in r.body && 'listoParaActivar' in r.body);
    });
    await t('PERM', 'negocio inexistente -> 404', async () => {
      const r = await api(srv.base, rutaChecklist('00000000-0000-0000-0000-000000000000'), { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 404);
    });

    await t('MANUAL', 'las 3 confirmaciones manuales se completan vía PATCH checklist ya existente', async () => {
      const r = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioC}/checklist`, {
        cookie: cookieSuperadmin, method: 'PATCH',
        body: { checklist: { mensaje_inicial_revisado: true, prueba_manual_confirmada: true, aceptacion_administrador: true } },
      });
      assert.strictEqual(r.status, 200);
      const chk = await api(srv.base, rutaChecklist(SEED.negocioC), { cookie: cookieSuperadmin });
      assert.strictEqual(chk.body.manuales.mensaje_inicial_revisado, true);
      assert.strictEqual(chk.body.manuales.prueba_manual_confirmada, true);
      assert.strictEqual(chk.body.manuales.aceptacion_administrador, true);
    });

    await t('GATE-ASESOR', 'sin integración conectada todavía -> listoParaActivar sigue false (falta el último automático)', async () => {
      const chk = await api(srv.base, rutaChecklist(SEED.negocioC), { cookie: cookieSuperadmin });
      assert.strictEqual(chk.body.automaticos.integracion_conectada, false);
      assert.strictEqual(chk.body.listoParaActivar, false);
    });

    await t('GATE-ASESOR', 'PATCH bot-whatsapp NUNCA se bloquea a nivel API aunque el checklist esté incompleto (asesor, no obligatorio -- decisión documentada para no bloquear reactivación de un negocio ya operando)', async () => {
      const antes = await obtenerBotWhatsappActivoNegocio(SEED.negocioC);
      assert.strictEqual(antes, false);
      const r = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioC}/bot-whatsapp`, { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: true } });
      assert.strictEqual(r.status, 200);
      await api(srv.base, `/api/superadmin/negocios/${SEED.negocioC}/bot-whatsapp`, { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: false } }); // revertir
    });

    await t('GATE-ASESOR', 'apagar el bot nunca requiere checklist (siempre la acción segura)', async () => {
      await api(srv.base, `/api/superadmin/negocios/${SEED.negocioC}/bot-whatsapp`, { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: true } });
      const r = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioC}/bot-whatsapp`, { cookie: cookieSuperadmin, method: 'PATCH', body: { activo: false } });
      assert.strictEqual(r.status, 200);
    });

    // ── Fase 6: aviso previo a migración (Embedded Signup estándar) ──
    const rutaAviso = (id) => `/api/superadmin/negocios/${id}/integraciones/whatsapp/aviso-migracion`;
    await t('AVISO', 'sin sesión -> 401', async () => {
      const r = await api(srv.base, rutaAviso(SEED.negocioA), { method: 'POST' });
      assert.strictEqual(r.status, 401);
    });
    await t('AVISO', 'admin normal -> 403', async () => {
      const r = await api(srv.base, rutaAviso(SEED.negocioA), { cookie: cookieAdminA, method: 'POST' });
      assert.strictEqual(r.status, 403);
    });
    await t('AVISO', 'staff -> 403', async () => {
      const r = await api(srv.base, rutaAviso(SEED.negocioA), { cookie: cookieStaffA, method: 'POST' });
      assert.strictEqual(r.status, 403);
    });
    await t('AVISO', 'negocio inexistente -> 404', async () => {
      const r = await api(srv.base, rutaAviso('00000000-0000-0000-0000-000000000000'), { cookie: cookieSuperadmin, method: 'POST' });
      assert.strictEqual(r.status, 404);
    });
    await t('AVISO', 'superadmin -> 200, devuelve la versión del aviso', async () => {
      const r = await api(srv.base, rutaAviso(SEED.negocioA), { cookie: cookieSuperadmin, method: 'POST' });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.version);
    });
    await t('AVISO', 'auditoría registra negocio/usuario/fecha/versión, nunca número/token/secretos', async () => {
      const { rows } = await pool.query(
        `SELECT negocio_id, superadmin_id, contexto, created_at FROM auditoria_plataforma
         WHERE negocio_id = $1 AND accion = 'aviso_migracion_whatsapp_aceptado' ORDER BY created_at DESC LIMIT 1`,
        [SEED.negocioA]
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].negocio_id, SEED.negocioA);
      assert.ok(rows[0].superadmin_id);
      assert.ok(rows[0].created_at);
      assert.ok(rows[0].contexto.version);
      const texto = JSON.stringify(rows);
      assert.ok(!/token|password|secret|phone_number|access_token/i.test(texto));
    });
  } finally { srv.detener(); }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
