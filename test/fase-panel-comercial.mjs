// Suite persistida: panel comercial mínimo (producto vendible). Cubre
// configuración editable del negocio (reglas_atencion validada),
// catálogo autoadministrable (agotado/destacado/duplicar/orden),
// simulador del bot (aislamiento por negocio, sin efectos reales),
// onboarding guiado (reusa el checklist existente), diagnóstico (nunca
// expone secretos) y plan comercial (exclusivo de Superadmin).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4110';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, crearUsuarioConPassword } = await import('../src/services/database.js');
const { validarEstructuraReglas, formatearHorarioTexto, formatearPagoTexto } = await import('../src/agent/prompts.js');

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

const adminNegocioB = await crearUsuarioConPassword({
  negocioId: SEED.negocioB, nombre: 'Admin Negocio B (panel comercial)', email: 'admin-b-panelcomercial@test.local',
  password: 'ClaveAdminBPrueba123!', rol: 'admin',
});
// El seed compartido (test/seed-datos-prueba.mjs) solo habilita el
// módulo whatsapp para negocioA -- esta suite necesita 'menu' activo
// para probar el catálogo autoadministrable (Fase 3).
await pool.query(
  `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'menu','activo')
   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`,
  [SEED.negocioA]
);
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieAdminB = cookieHeader(adminNegocioB.id, SEED.negocioB, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');
const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');

const REGLAS_VALIDAS = {
  horarios: {
    lunes:{abierto:true,apertura:'09:00',cierre:'18:00'}, martes:{abierto:true,apertura:'09:00',cierre:'18:00'},
    miercoles:{abierto:true,apertura:'09:00',cierre:'18:00'}, jueves:{abierto:true,apertura:'09:00',cierre:'18:00'},
    viernes:{abierto:true,apertura:'09:00',cierre:'18:00'}, sabado:{abierto:false,apertura:null,cierre:null},
    domingo:{abierto:false,apertura:null,cierre:null},
  },
  pedidos: { costo_envio:30, pedido_minimo_entrega:0, modalidades:['entrega a domicilio'], pago_aceptado:['efectivo'] },
  cierres_especiales: [], promociones: [], politicas: ['Sin cambios una vez confirmado.'],
};

// ═══════════ Unidad: prompts.js (validación y generadores) ═══════════
await t('PROMPTS', 'validarEstructuraReglas acepta una estructura completa válida', () => {
  assert.strictEqual(validarEstructuraReglas(REGLAS_VALIDAS), true);
});
await t('PROMPTS', 'validarEstructuraReglas rechaza sin los 7 días', () => {
  assert.strictEqual(validarEstructuraReglas({ ...REGLAS_VALIDAS, horarios: { lunes: REGLAS_VALIDAS.horarios.lunes } }), false);
});
await t('PROMPTS', 'validarEstructuraReglas rechaza costo_envio no numérico', () => {
  assert.strictEqual(validarEstructuraReglas({ ...REGLAS_VALIDAS, pedidos: { ...REGLAS_VALIDAS.pedidos, costo_envio: '30' } }), false);
});
await t('PROMPTS', 'validarEstructuraReglas acepta bot.* opcional válido', () => {
  assert.strictEqual(validarEstructuraReglas({ ...REGLAS_VALIDAS, bot: { tono:'formal', faqs:[{pregunta:'a',respuesta:'b'}], respuestas_prohibidas:['x'] } }), true);
});
await t('PROMPTS', 'validarEstructuraReglas rechaza bot.faqs mal formado', () => {
  assert.strictEqual(validarEstructuraReglas({ ...REGLAS_VALIDAS, bot: { faqs: [{ pregunta: 'a' }] } }), false);
});
await t('PROMPTS', 'formatearHorarioTexto agrupa días consecutivos iguales', () => {
  assert.strictEqual(formatearHorarioTexto(REGLAS_VALIDAS.horarios), 'Lunes a viernes 09:00–18:00 | Sábado a domingo: cerrado');
});
await t('PROMPTS', 'formatearPagoTexto lista métodos conocidos con descripción', () => {
  const texto = formatearPagoTexto(['efectivo','transferencia']);
  assert.ok(texto.includes('Efectivo'));
  assert.ok(texto.includes('Transferencia bancaria'));
});

// ═══════════ Fase 2: configuración editable (reglas_atencion) ═══════════
{
  const srv = await arrancarServidor({ PORT: PUERTO });
  try {
    await t('CONFIG', 'PUT /api/config con reglas_atencion inválida -> 400', async () => {
      const r = await api(srv.base, '/api/config', { cookie: cookieAdminA, method:'PUT', body: { reglas_atencion: { horarios: {} } } });
      assert.strictEqual(r.status, 400);
    });
    await t('CONFIG', 'PUT /api/config con reglas_atencion válida -> 200, se persiste como JSON', async () => {
      const r = await api(srv.base, '/api/config', { cookie: cookieAdminA, method:'PUT', body: { reglas_atencion: REGLAS_VALIDAS } });
      assert.strictEqual(r.status, 200);
      const guardado = JSON.parse(r.body.config.reglas_atencion);
      assert.strictEqual(guardado.pedidos.costo_envio, 30);
    });
    await t('CONFIG', 'staff no puede editar /api/config -> 403', async () => {
      const r = await api(srv.base, '/api/config', { cookie: cookieStaffA, method:'PUT', body: { nombre: 'x' } });
      assert.strictEqual(r.status, 403);
    });
    await t('CONFIG', 'sin sesión -> 401', async () => {
      const r = await api(srv.base, '/api/config', { method:'PUT', body: { nombre: 'x' } });
      assert.strictEqual(r.status, 401);
    });
    await t('CONFIG', 'el prompt del bot refleja horario/pago/zonas configurados (integración end-to-end)', async () => {
      const { construirSystemPrompt } = await import('../src/agent/prompts.js');
      const prompt = await construirSystemPrompt(null, null, SEED.negocioA);
      assert.ok(prompt.includes('Lunes a viernes 09:00–18:00'));
      assert.ok(prompt.includes('Efectivo'));
    });

    // ── Fase 3: catálogo (agotado/destacado/duplicar/orden) ──
    const { rows: [cat] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, orden, activa) VALUES ($1,'Categoría prueba panel comercial',1,TRUE) RETURNING id`, [SEED.negocioA]
    );
    let productoId;
    await t('CATALOGO', 'crear producto con agotado/destacado explícitos', async () => {
      const r = await api(srv.base, '/api/admin/menu/productos', { cookie: cookieAdminA, method:'POST', body: { categoria_id: cat.id, nombre:'Producto prueba', precio:99, agotado:false, destacado:true } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.destacado, true);
      productoId = r.body.id;
    });
    await t('CATALOGO', 'marcar agotado vía PATCH', async () => {
      const r = await api(srv.base, `/api/admin/menu/productos/${productoId}`, { cookie: cookieAdminA, method:'PATCH', body: { agotado: true } });
      assert.strictEqual(r.status, 200);
      const { rows } = await pool.query('SELECT agotado FROM menu_productos WHERE id=$1', [productoId]);
      assert.strictEqual(rows[0].agotado, true);
    });
    await t('CATALOGO', 'producto agotado no aparece en el menú que arma el bot', async () => {
      const { construirSystemPrompt } = await import('../src/agent/prompts.js');
      const prompt = await construirSystemPrompt(null, null, SEED.negocioA);
      assert.ok(!prompt.includes('Producto prueba'));
    });
    await t('CATALOGO', 'duplicar producto crea una copia inactiva con "Copia de" en el nombre', async () => {
      const r = await api(srv.base, `/api/admin/menu/productos/${productoId}/duplicar`, { cookie: cookieAdminA, method:'POST' });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.nombre.startsWith('Copia de'));
      assert.strictEqual(r.body.disponible, false);
    });
    await t('CATALOGO', 'staff no puede crear productos -> 403', async () => {
      const r = await api(srv.base, '/api/admin/menu/productos', { cookie: cookieStaffA, method:'POST', body: { categoria_id: cat.id, nombre:'x', precio:1 } });
      assert.strictEqual(r.status, 403);
    });
    await t('CATALOGO', 'reordenar categoría (orden) vía PATCH', async () => {
      const { rows: [cat2] } = await pool.query(
        `INSERT INTO menu_categorias (negocio_id, nombre, orden, activa) VALUES ($1,'Categoría 2',2,TRUE) RETURNING id`, [SEED.negocioA]
      );
      const r = await api(srv.base, `/api/admin/menu/categorias/${cat.id}`, { cookie: cookieAdminA, method:'PATCH', body: { orden: 5 } });
      assert.strictEqual(r.status, 200);
      const { rows } = await pool.query('SELECT orden FROM menu_categorias WHERE id=$1', [cat.id]);
      assert.strictEqual(rows[0].orden, 5);
    });

    // ── Fase 4: simulador (aislamiento, sin efectos reales) ──
    let simSessionA;
    await t('SIMULADOR', 'crear sesión de simulador devuelve un sessionId con el negocio embebido', async () => {
      const r = await api(srv.base, '/api/admin/bot-simulador/sesion', { cookie: cookieAdminA, method:'POST' });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.sessionId.startsWith(`sim-${SEED.negocioA}-`));
      simSessionA = r.body.sessionId;
    });
    await t('SIMULADOR', 'sessionId de un negocio no se puede usar desde otro negocio', async () => {
      const r = await api(srv.base, '/api/admin/bot-simulador/mensaje', { cookie: cookieAdminB, method:'POST', body: { sessionId: simSessionA, mensaje: 'hola' } });
      assert.strictEqual(r.status, 400);
    });
    await t('SIMULADOR', 'sessionId inventado (sin prefijo sim-) -> 400', async () => {
      const r = await api(srv.base, '/api/admin/bot-simulador/mensaje', { cookie: cookieAdminA, method:'POST', body: { sessionId: '5218780009001', mensaje: 'hola' } });
      assert.strictEqual(r.status, 400);
    });
    await t('SIMULADOR', 'staff no puede iniciar sesión de simulador -> 403', async () => {
      const r = await api(srv.base, '/api/admin/bot-simulador/sesion', { cookie: cookieStaffA, method:'POST' });
      assert.strictEqual(r.status, 403);
    });
    await t('SIMULADOR', 'el simulador nunca escribe en la tabla mensajes (sin efectos reales)', async () => {
      const antes = (await pool.query(`SELECT count(*) FROM mensajes WHERE negocio_id = $1`, [SEED.negocioA])).rows[0].count;
      // Sin ANTHROPIC_API_KEY real en el entorno de prueba, la llamada al
      // modelo fallará (502) -- lo que se confirma aquí es que, falle o no,
      // nunca se persiste nada en `mensajes` (a diferencia de un mensaje real).
      await api(srv.base, '/api/admin/bot-simulador/mensaje', { cookie: cookieAdminA, method:'POST', body: { sessionId: simSessionA, mensaje: 'hola quiero un pedido' } });
      const despues = (await pool.query(`SELECT count(*) FROM mensajes WHERE negocio_id = $1`, [SEED.negocioA])).rows[0].count;
      assert.strictEqual(antes, despues);
    });
    await t('SIMULADOR', 'limpiar sesión de simulador -> 200 (idempotente)', async () => {
      const r1 = await api(srv.base, `/api/admin/bot-simulador/${simSessionA}`, { cookie: cookieAdminA, method:'DELETE' });
      const r2 = await api(srv.base, `/api/admin/bot-simulador/${simSessionA}`, { cookie: cookieAdminA, method:'DELETE' });
      assert.strictEqual(r1.status, 200);
      assert.strictEqual(r2.status, 200);
    });

    // ── Fase 5: onboarding guiado (reusa el checklist existente) ──
    await t('ONBOARDING', 'GET /api/admin/checklist-activacion-bot devuelve automaticos/manuales/listoParaActivar', async () => {
      const r = await api(srv.base, '/api/admin/checklist-activacion-bot', { cookie: cookieAdminA });
      assert.strictEqual(r.status, 200);
      assert.ok('automaticos' in r.body && 'manuales' in r.body && 'listoParaActivar' in r.body);
    });
    await t('ONBOARDING', 'PATCH /api/admin/checklist solo acepta las 3 claves de autoservicio', async () => {
      const rMala = await api(srv.base, '/api/admin/checklist', { cookie: cookieAdminA, method:'PATCH', body: { checklist: { whatsapp_configurado: true } } });
      assert.strictEqual(rMala.status, 400);
      const rBuena = await api(srv.base, '/api/admin/checklist', { cookie: cookieAdminA, method:'PATCH', body: { checklist: { prueba_manual_confirmada: true } } });
      assert.strictEqual(rBuena.status, 200);
      const chk = await api(srv.base, '/api/admin/checklist-activacion-bot', { cookie: cookieAdminA });
      assert.strictEqual(chk.body.manuales.prueba_manual_confirmada, true);
    });
    await t('ONBOARDING', 'admin de otro negocio no ve ni modifica el checklist de A (aislamiento)', async () => {
      const r = await api(srv.base, '/api/admin/checklist-activacion-bot', { cookie: cookieAdminB });
      assert.strictEqual(r.status, 200);
      assert.notStrictEqual(r.body.manuales.prueba_manual_confirmada, undefined); // tiene su propio objeto, no el de A
      const { rows } = await pool.query('SELECT checklist FROM negocios WHERE id = $1', [SEED.negocioB]);
      assert.notStrictEqual((rows[0].checklist||{}).prueba_manual_confirmada, true); // B no heredó el true de A
    });

    // ── Fase 6: diagnóstico (nunca expone secretos) ──
    await t('DIAGNOSTICO', 'GET /api/admin/diagnostico devuelve la forma esperada, nunca tokens', async () => {
      const r = await api(srv.base, '/api/admin/diagnostico', { cookie: cookieAdminA });
      assert.strictEqual(r.status, 200);
      assert.ok('whatsapp' in r.body && 'chats' in r.body && 'operacion' in r.body && 'integraciones' in r.body);
      const texto = JSON.stringify(r.body);
      assert.ok(!/token|access_token_cifrado|token_iv|token_auth_tag|password/i.test(texto));
    });
    await t('DIAGNOSTICO', 'staff no puede ver diagnóstico -> 403', async () => {
      const r = await api(srv.base, '/api/admin/diagnostico', { cookie: cookieStaffA });
      assert.strictEqual(r.status, 403);
    });

    // ── Fase 7: plan comercial (exclusivo Superadmin) ──
    await t('PLAN_COMERCIAL', 'admin del propio negocio NO puede ver el plan comercial -> 401/403', async () => {
      const r = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/plan-comercial`, { cookie: cookieAdminA });
      assert.ok(r.status === 401 || r.status === 403);
    });
    await t('PLAN_COMERCIAL', 'superadmin puede leer y actualizar el plan comercial', async () => {
      const rGet = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/plan-comercial`, { cookie: cookieSuperadmin });
      assert.strictEqual(rGet.status, 200);
      assert.strictEqual(rGet.body.estado, 'prospecto'); // default seguro, nunca inventado
      const rPatch = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/plan-comercial`, { cookie: cookieSuperadmin, method:'PATCH', body: { estado:'activo', mensualidad: 999, responsable: 'Equipo Xabor' } });
      assert.strictEqual(rPatch.status, 200);
      assert.strictEqual(rPatch.body.estado, 'activo');
      assert.strictEqual(Number(rPatch.body.mensualidad), 999);
    });
    await t('PLAN_COMERCIAL', 'estado inválido -> 400, nunca se guarda', async () => {
      const r = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioA}/plan-comercial`, { cookie: cookieSuperadmin, method:'PATCH', body: { estado:'no_existe' } });
      assert.strictEqual(r.status, 400);
    });
    await t('PLAN_COMERCIAL', 'el plan comercial de A no afecta el de B (aislamiento)', async () => {
      const r = await api(srv.base, `/api/superadmin/negocios/${SEED.negocioB}/plan-comercial`, { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 200);
      assert.notStrictEqual(r.body.estado, 'activo'); // B nunca heredó el cambio de A
    });
    await t('PLAN_COMERCIAL', 'auditoría registra el cambio, sin datos sensibles', async () => {
      const { rows } = await pool.query(
        `SELECT negocio_id, superadmin_id, estado_nuevo FROM auditoria_plataforma WHERE negocio_id=$1 AND accion='cambiar_plan_comercial_negocio' ORDER BY created_at DESC LIMIT 1`,
        [SEED.negocioA]
      );
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].estado_nuevo.estado, 'activo');
    });
  } finally { srv.detener(); }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
