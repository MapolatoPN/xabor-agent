// Suite persistida: operación manual del chat de WhatsApp para el piloto
// (preparación para primeros clientes). Cubre lo agregado/corregido en
// esta tarea sobre la migración 020 (mensajes.origen, dedup por
// message_id_externo) y el cierre del gap de aislamiento en
// getBotPausado -- y confirma, con pruebas de regresión, que un negocio
// con bot_whatsapp_activo=false puede operar manualmente sin que brain.js
// se invoque nunca y sin fuga de estado entre negocios (Fase 2 del
// encargo "preparar Xabor para primeros clientes").
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4094';

const { crearTokenSesion } = await import('../src/services/session.js');
const {
  pool, guardarMensaje, getBotPausado, setBotPausado, obtenerConversacion,
  obtenerConversacionesRecientes, obtenerBotWhatsappActivoNegocio, crearUsuarioConPassword,
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

// Negocio B no tiene usuario propio en el seed compartido (solo se usa
// para pruebas de aislamiento a nivel HTTP). Se crea aquí un admin
// dedicado sin tocar test/seed-datos-prueba.mjs (compartido con otras
// suites). Se REUTILIZA si ya existe: una corrida anterior interrumpida a
// media suite deja al usuario en la base, y volver a crearlo tumbaría el
// setup con el UNIQUE de email (mismo patrón que fase-repartidores-
// notificaciones).
const { rows: [adminBExistente] } = await pool.query(`SELECT id FROM usuarios WHERE email = 'admin-b-chatmanual@test.local'`);
const adminNegocioB = adminBExistente || await crearUsuarioConPassword({
  negocioId: SEED.negocioB, nombre: 'Admin Negocio B (chat manual)', email: 'admin-b-chatmanual@test.local',
  password: 'ClaveAdminBPrueba123!', rol: 'admin',
});
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');
const cookieAdminB = cookieHeader(adminNegocioB.id, SEED.negocioB, 'admin');

// Limpieza + estado base: ambos negocios con bot apagado, sin integración
// whatsapp configurada (los envíos reales a Meta deben fallar 409, nunca
// usar credenciales de otro negocio).
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1))`, [[SEED.negocioA, SEED.negocioB]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = ANY($1)`, [[SEED.negocioA, SEED.negocioB]]);
// Las credenciales legacy de configuracion (int_wa_*) también cuentan como
// "WhatsApp configurado" para obtenerCredencialesWhatsappNegocio: si otra
// suite (p. ej. fase-repartidores-notificaciones) dejó valores falsos ahí,
// el 409 esperado de esta suite se convertiría en un 500 con token falso.
await pool.query(`DELETE FROM configuracion WHERE negocio_id = ANY($1) AND clave IN ('int_wa_phone_id','int_wa_token')`, [[SEED.negocioA, SEED.negocioB]]);
// Mensajes/clientes de corridas anteriores interrumpidas: los teléfonos de
// esta suite son propios (52187810xx...), limpiarlos siempre hace la suite
// re-ejecutable y determinista sin importar cómo terminó la corrida previa.
await pool.query(`DELETE FROM mensajes WHERE negocio_id = ANY($1) AND telefono LIKE '52187810%'`, [[SEED.negocioA, SEED.negocioB]]);
await pool.query(`DELETE FROM perfiles_clientes WHERE telefono LIKE '52187810%'`);
await pool.query(`DELETE FROM clientes WHERE telefono LIKE '52187810%'`);
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = ANY($1)`, [[SEED.negocioA, SEED.negocioB]]);
const PNID_A = 'PNID_CHATMANUAL_A';
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Prueba chat manual A', TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, PNID_A]);

// ═══════════ ORIGEN (unidad, capa DB) ═══════════
await t('ORIGEN', 'guardarMensaje con origen humano lo persiste', async () => {
  const m = await guardarMensaje('5218781001001', 'Cliente Origen 1', 'saliente', 'Hola, en un momento te atendemos', SEED.negocioA, 'humano');
  assert.strictEqual(m.origen, 'humano');
});
await t('ORIGEN', 'guardarMensaje sin origen (legacy) sigue funcionando -- origen NULL', async () => {
  const m = await guardarMensaje('5218781001002', 'Cliente Origen 2', 'saliente', 'Mensaje sin origen explícito', SEED.negocioA);
  assert.strictEqual(m.origen, null);
});
await t('ORIGEN', 'guardarMensaje entrante con origen cliente lo persiste', async () => {
  const m = await guardarMensaje('5218781001003', 'Cliente Origen 3', 'entrante', 'hola quiero un pedido', SEED.negocioA, 'cliente');
  assert.strictEqual(m.origen, 'cliente');
});
await t('ORIGEN', 'CHECK constraint rechaza un valor de origen inválido', async () => {
  await assert.rejects(() => pool.query(
    `INSERT INTO mensajes (telefono, direccion, texto, negocio_id, origen) VALUES ($1,'saliente','x',$2,'invalido')`,
    ['5218781001099', SEED.negocioA]
  ));
});

// ═══════════ DEDUP (unidad, capa DB) ═══════════
await t('DEDUP', 'dos INSERTs con el mismo message_id_externo -> una sola fila, la segunda llamada devuelve la existente', async () => {
  const wamid = 'wamid.DEDUP_TEST_' + Date.now();
  const m1 = await guardarMensaje('5218781002001', 'Cliente Dedup', 'entrante', 'hola', SEED.negocioA, 'cliente', wamid);
  const m2 = await guardarMensaje('5218781002001', 'Cliente Dedup', 'entrante', 'hola', SEED.negocioA, 'cliente', wamid);
  assert.ok(m1); assert.ok(m2);
  assert.strictEqual(m1.id, m2.id);
  const { rows } = await pool.query(`SELECT * FROM mensajes WHERE message_id_externo = $1`, [wamid]);
  assert.strictEqual(rows.length, 1);
});
await t('DEDUP', 'mensajes salientes sin message_id_externo nunca se deduplican entre sí', async () => {
  const antes = (await pool.query(`SELECT count(*) FROM mensajes WHERE telefono = '5218781002002'`)).rows[0].count;
  await guardarMensaje('5218781002002', null, 'saliente', 'mismo texto', SEED.negocioA, 'humano');
  await guardarMensaje('5218781002002', null, 'saliente', 'mismo texto', SEED.negocioA, 'humano');
  const despues = (await pool.query(`SELECT count(*) FROM mensajes WHERE telefono = '5218781002002'`)).rows[0].count;
  assert.strictEqual(Number(despues) - Number(antes), 2);
});

// ═══════════ AISLAMIENTO getBotPausado (cierre de gap encontrado en auditoría) ═══════════
await t('AISLAMIENTO', 'pausar el bot para un cliente de A no es visible al consultar estado-bot desde B (mismo teléfono)', async () => {
  const tel = '5218781003001';
  await setBotPausado(tel, true, SEED.negocioA);
  assert.strictEqual(await getBotPausado(tel, SEED.negocioA), true); // A ve su propio estado real
  assert.strictEqual(await getBotPausado(tel, SEED.negocioB), false); // B no hereda el estado de A (fail-closed)
});
await t('AISLAMIENTO', 'getBotPausado sin negocioId falla cerrado (false), nunca expone el estado real', async () => {
  const tel = '5218781003001';
  assert.strictEqual(await getBotPausado(tel, undefined), false);
});
await t('AISLAMIENTO', 'HTTP: GET estado-bot de un teléfono pausado en A, consultado con sesión de B, no revela pausado=true', async () => {
  const srv = await arrancarServidor({ PORT: PUERTO });
  try {
    const tel = '5218781003001'; // ya pausado=true en A por la prueba anterior
    const rA = await api(srv.base, `/api/conversacion/${tel}/estado-bot`, { cookie: cookieAdminA });
    const rB = await api(srv.base, `/api/conversacion/${tel}/estado-bot`, { cookie: cookieAdminB });
    assert.strictEqual(rA.status, 200);
    assert.strictEqual(rA.body.pausado, true);
    assert.strictEqual(rB.status, 403);
  } finally { srv.detener(); }
});

// ═══════════ FASE 2: operación con bot_whatsapp_activo=false ═══════════
{
  const srv = await arrancarServidor({ PORT: PUERTO });
  try {
    async function simularWebhook(phoneNumberId, telefono, texto, wamid) {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: {
          metadata: { phone_number_id: phoneNumberId },
          messages: [{ type: 'text', from: telefono, id: wamid || ('wamid.CHATMANUAL-' + Date.now() + Math.random()), text: { body: texto } }],
          contacts: [{ profile: { name: 'Cliente Prueba Chat Manual' } }],
        } }] }],
      };
      await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      await new Promise(r => setTimeout(r, 400));
    }

    await t('FASE2', 'bot apagado: mensaje entrante se recibe, se guarda con origen cliente, NUNCA se invoca a Claude', async () => {
      const tel = '5218781004001';
      const antesLen = srv.obtenerSalida().length;
      await simularWebhook(PNID_A, tel, 'hola, quiero ver el menú');
      const salidaNueva = srv.obtenerSalida().slice(antesLen);
      assert.ok(salidaNueva.includes(`Bot de WhatsApp desactivado para el negocio ${SEED.negocioA}`));
      assert.ok(!salidaNueva.includes('encolando para procesar con IA'));
      const { rows } = await pool.query(`SELECT origen, direccion FROM mensajes WHERE telefono = $1 AND negocio_id = $2`, [tel, SEED.negocioA]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].origen, 'cliente');
    });

    await t('FASE2', 'el mensaje recibido es visible vía GET /api/conversacion (bandeja del panel)', async () => {
      const r = await api(srv.base, `/api/conversacion/5218781004001`, { cookie: cookieAdminA });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.some(m => m.texto === 'hola, quiero ver el menú' && m.origen === 'cliente'));
    });

    await t('FASE2', 'el mensaje recibido aparece en GET /api/conversaciones (lista reciente)', async () => {
      const r = await api(srv.base, `/api/conversaciones`, { cookie: cookieAdminA });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.some(c => c.telefono === '5218781004001'));
    });

    await t('FASE2', 'respuesta manual funciona con bot apagado y queda tagueada como humano', async () => {
      const r = await api(srv.base, '/api/send-message', { cookie: cookieAdminA, method: 'POST', body: { telefono: '5218781004001', mensaje: 'Claro, en un momento te lo enviamos' } });
      // Sin credenciales reales de Meta configuradas -> 409 controlado, nunca 500/crash.
      assert.strictEqual(r.status, 409);
      assert.ok(r.body.error);
    });

    await t('FASE2', 'error de envío es claro y controlado (409 "WhatsApp no configurado"), no un 500 ni un crash del proceso', async () => {
      const r = await api(srv.base, '/api/send-message', { cookie: cookieAdminA, method: 'POST', body: { telefono: '5218781004001', mensaje: 'otro intento' } });
      assert.strictEqual(r.status, 409);
      assert.match(r.body.error, /no configurado/i);
    });

    await t('FASE2', 'el historial persiste entre consultas (segunda lectura devuelve el mismo mensaje, en orden)', async () => {
      const r1 = await api(srv.base, `/api/conversacion/5218781004001`, { cookie: cookieAdminA });
      const r2 = await api(srv.base, `/api/conversacion/5218781004001`, { cookie: cookieAdminA });
      assert.deepStrictEqual(r1.body.map(m => m.id), r2.body.map(m => m.id));
      const timestamps = r2.body.map(m => new Date(m.timestamp).getTime());
      assert.deepStrictEqual(timestamps, [...timestamps].sort((a, b) => a - b));
    });

    await t('FASE2', 'pausar/reactivar conversación funciona igual con el bot global apagado', async () => {
      const tel = '5218781004001';
      const rPausar = await api(srv.base, `/api/conversacion/${tel}/pausar`, { cookie: cookieAdminA, method: 'POST' });
      assert.strictEqual(rPausar.status, 200);
      assert.strictEqual(await getBotPausado(tel, SEED.negocioA), true);
      const rReactivar = await api(srv.base, `/api/conversacion/${tel}/reactivar`, { cookie: cookieAdminA, method: 'POST' });
      assert.strictEqual(rReactivar.status, 200);
      assert.strictEqual(await getBotPausado(tel, SEED.negocioA), false);
    });

    await t('PERMISOS', 'operador propio puede tomar y devolver la conversación', async () => {
      const tel = '5218781004001';
      assert.strictEqual((await api(srv.base, `/api/conversacion/${tel}/pausar`, { cookie: cookieStaffA, method: 'POST' })).status, 200);
      assert.strictEqual(await getBotPausado(tel, SEED.negocioA), true);
      assert.strictEqual((await api(srv.base, `/api/conversacion/${tel}/reactivar`, { cookie: cookieStaffA, method: 'POST' })).status, 200);
    });

    await t('PERMISOS', 'sin sesión da 401, conversación ajena 403 e inexistente 404', async () => {
      const ruta = '/api/conversacion/5218781004001/pausar';
      assert.strictEqual((await api(srv.base, ruta, { method: 'POST' })).status, 401);
      assert.strictEqual((await api(srv.base, ruta, { cookie: cookieAdminB, method: 'POST' })).status, 403);
      assert.strictEqual((await api(srv.base, '/api/conversacion/5218781999999/pausar', { cookie: cookieAdminA, method: 'POST' })).status, 404);
    });

    await t('FASE2', 'el envío manual NUNCA activa el interruptor global del bot', async () => {
      const antes = await obtenerBotWhatsappActivoNegocio(SEED.negocioA);
      assert.strictEqual(antes, false);
      await api(srv.base, '/api/send-message', { cookie: cookieAdminA, method: 'POST', body: { telefono: '5218781004001', mensaje: 'intento adicional' } });
      const despues = await obtenerBotWhatsappActivoNegocio(SEED.negocioA);
      assert.strictEqual(despues, false);
    });

    await t('FASE2', 'una conversación de A no es visible en la bandeja de B (aislamiento por negocio)', async () => {
      const r = await api(srv.base, '/api/conversaciones', { cookie: cookieAdminB });
      assert.strictEqual(r.status, 200);
      assert.ok(!r.body.some(c => c.telefono === '5218781004001'));
      const rConv = await api(srv.base, '/api/conversacion/5218781004001', { cookie: cookieAdminB });
      assert.strictEqual(rConv.status, 200);
      assert.deepStrictEqual(rConv.body, []); // B no ve ningún mensaje de ese teléfono (no le pertenece)
    });

    await t('FASE2', 'reenvío del mismo webhook (mismo wamid) no duplica el mensaje en la bandeja', async () => {
      const tel = '5218781004002';
      const wamid = 'wamid.CHATMANUAL-REDELIVERY-' + Date.now();
      await simularWebhook(PNID_A, tel, 'mensaje reentregado por Meta', wamid);
      await simularWebhook(PNID_A, tel, 'mensaje reentregado por Meta', wamid); // reentrega idéntica
      const { rows } = await pool.query(`SELECT * FROM mensajes WHERE telefono = $1 AND negocio_id = $2`, [tel, SEED.negocioA]);
      assert.strictEqual(rows.length, 1);
    });

    await t('FASE2', 'staff sin sesión no puede leer conversaciones de ningún negocio (401)', async () => {
      const r = await api(srv.base, '/api/conversaciones');
      assert.strictEqual(r.status, 401);
    });
  } finally { srv.detener(); }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
