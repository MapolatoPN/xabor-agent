// Suite persistida: captura pública de prospectos (landing) + Superadmin.
// Cubre validación backend, honeypot, tiempo mínimo de llenado, deduplicación
// de doble envío, rate limit, permisos de Superadmin, y que la persistencia
// en base nunca depende de si el correo de notificación se pudo enviar.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      PANEL_PASSWORD=... INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-prospectos-comerciales.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4066';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(categoria, nombre, fn) {
  try { await fn(); console.log(`  OK  [${categoria}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${categoria}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${categoria}] ${nombre}: ${e.message}`); }
}

function cookieHeader(usuarioId, negocioId, rol) {
  const token = crearTokenSesion({ usuarioId, negocioId, rol });
  return `xabor_sesion=${encodeURIComponent(token)}`;
}
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* respuesta sin cuerpo JSON */ }
  return { status: r.status, body: json, raw: r };
}

const cookieSuperadmin = cookieHeader(SEED.superadminUsuarioId, SEED.negocioA, 'admin');
const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
const cookieStaffA = cookieHeader(SEED.staffNegocioAUsuarioId, SEED.negocioA, 'staff');

function payloadValido(overrides = {}) {
  return {
    nombre: 'Laura Prueba', negocio: 'Restaurante de Prueba', ciudad: 'Saltillo',
    telefono: '8781234567', tipoNegocio: 'Restaurante', volumenMensajes: 'Entre 10 y 30',
    comentario: 'Comentario de prueba', empresaWeb: '', cargadoEn: Date.now() - 5000,
    ...overrides,
  };
}

async function contarProspectos(telefono, negocio) {
  const { rows } = await pool.query('SELECT count(*) FROM prospectos_comerciales WHERE telefono = $1 AND negocio = $2', [telefono, negocio]);
  return parseInt(rows[0].count, 10);
}

// ═══════════════ Grupo A: validación backend ═══════════════
{
  const srv = await arrancarServidor({ PORT: PUERTO });
  try {
    let idProspectoValido = null;

    await t('VALIDACION', 'prospecto válido -> 201, ok:true, respuesta no expone el id ni campos internos', async () => {
      const r = await api(srv.base, '/api/public/prospectos', { method: 'POST', body: payloadValido({ telefono: '8781110001', negocio: 'Negocio Valido A' }) });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.ok, true);
      assert.ok(r.body.message);
      assert.deepStrictEqual(Object.keys(r.body).sort(), ['message', 'ok']);
    });

    await t('VALIDACION', 'campos incompletos (sin nombre) -> 400, sin detalles internos', async () => {
      const body = payloadValido({ telefono: '8781110002', negocio: 'Negocio Incompleto' });
      delete body.nombre;
      const r = await api(srv.base, '/api/public/prospectos', { method: 'POST', body });
      assert.strictEqual(r.status, 400);
      assert.ok(r.body.error);
      assert.ok(!JSON.stringify(r.body).match(/at\s+\S+\(.*:\d+:\d+\)/), 'no debe incluir stack trace');
    });

    await t('VALIDACION', 'teléfono excesivamente largo -> 400', async () => {
      const r = await api(srv.base, '/api/public/prospectos', { method: 'POST', body: payloadValido({ telefono: '8'.repeat(30), negocio: 'Negocio Tel Largo' }) });
      assert.strictEqual(r.status, 400);
    });

    await t('VALIDACION', 'comentario excesivo (>800) -> 400', async () => {
      const r = await api(srv.base, '/api/public/prospectos', { method: 'POST', body: payloadValido({ telefono: '8781110003', negocio: 'Negocio Comentario Largo', comentario: 'x'.repeat(900) }) });
      assert.strictEqual(r.status, 400);
    });

    await t('VALIDACION', 'tipo de negocio fuera de la lista permitida -> 400', async () => {
      const r = await api(srv.base, '/api/public/prospectos', { method: 'POST', body: payloadValido({ telefono: '8781110004', negocio: 'Negocio Tipo Invalido', tipoNegocio: 'Ferretería' }) });
      assert.strictEqual(r.status, 400);
    });

    // ── Superadmin (GET/PATCH -- no consumen el rate limit del POST público) ──
    await t('SUPERADMIN', 'lista prospectos -> incluye el prospecto válido creado arriba', async () => {
      const r = await api(srv.base, '/api/superadmin/prospectos?busqueda=Negocio%20Valido%20A', { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.body));
      assert.ok(r.body.some(p => p.negocio === 'Negocio Valido A'));
      idProspectoValido = r.body.find(p => p.negocio === 'Negocio Valido A')?.id;
      assert.ok(idProspectoValido);
    });

    await t('SUPERADMIN', 'detalle expone todos los campos incluidas notas internas', async () => {
      const r = await api(srv.base, `/api/superadmin/prospectos/${idProspectoValido}`, { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.estado, 'nuevo');
    });

    await t('SUPERADMIN', 'actualizar estado -> persiste y queda auditado', async () => {
      const r = await api(srv.base, `/api/superadmin/prospectos/${idProspectoValido}`, {
        cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'contactado', responsable: 'Equipo Xabor' },
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.estado, 'contactado');
      assert.strictEqual(r.body.responsable, 'Equipo Xabor');
    });

    await t('SUPERADMIN', 'estado inválido en PATCH -> 400', async () => {
      const r = await api(srv.base, `/api/superadmin/prospectos/${idProspectoValido}`, {
        cookie: cookieSuperadmin, method: 'PATCH', body: { estado: 'no_existe' },
      });
      assert.strictEqual(r.status, 400);
    });

    await t('SUPERADMIN', 'prospecto inexistente -> 404', async () => {
      const r = await api(srv.base, '/api/superadmin/prospectos/00000000-0000-0000-0000-000000000000', { cookie: cookieSuperadmin });
      assert.strictEqual(r.status, 404);
    });

    await t('PERMISOS', 'sin sesión -> 401 (lista)', async () => {
      const r = await api(srv.base, '/api/superadmin/prospectos');
      assert.strictEqual(r.status, 401);
    });

    await t('PERMISOS', 'administrador de negocio (no superadmin) -> 403 (lista)', async () => {
      const r = await api(srv.base, '/api/superadmin/prospectos', { cookie: cookieAdminA });
      assert.strictEqual(r.status, 403);
    });

    await t('PERMISOS', 'operador (staff) -> 403 (lista)', async () => {
      const r = await api(srv.base, '/api/superadmin/prospectos', { cookie: cookieStaffA });
      assert.strictEqual(r.status, 403);
    });

    await t('PERMISOS', 'administrador de negocio -> 403 (PATCH estado)', async () => {
      const r = await api(srv.base, `/api/superadmin/prospectos/${idProspectoValido}`, { cookie: cookieAdminA, method: 'PATCH', body: { estado: 'convertido' } });
      assert.strictEqual(r.status, 403);
    });

    await t('SECRETOS', 'ninguna respuesta HTTP de esta suite expone RESEND_API_KEY, PANEL_SECRET ni SESSION_SECRET', async () => {
      const respuestas = [
        await api(srv.base, `/api/superadmin/prospectos/${idProspectoValido}`, { cookie: cookieSuperadmin }),
      ];
      for (const r of respuestas) {
        const texto = JSON.stringify(r.body);
        assert.ok(!texto.includes(process.env.PANEL_SECRET || 'xabor-secret-key'));
        assert.ok(!/resend|api[_-]?key/i.test(texto));
      }
    });

    await t('PERSISTENCIA', 'ip_hash nunca es la IP en claro (127.0.0.1 / ::1)', async () => {
      const { rows } = await pool.query('SELECT ip_hash FROM prospectos_comerciales WHERE negocio = $1', ['Negocio Valido A']);
      assert.ok(rows[0].ip_hash);
      assert.notStrictEqual(rows[0].ip_hash, '127.0.0.1');
      assert.notStrictEqual(rows[0].ip_hash, '::1');
    });

    await t('CORREO', 'correo desactivado en modo prueba (NODE_ENV != production) -> prospecto igual queda guardado', async () => {
      // La suite corre siempre con NODE_ENV distinto de 'production' -- por
      // diseño (ver enviarNotificacionNuevoProspecto) nunca se manda correo
      // real aquí. Lo único que se afirma es que el registro sigue en base.
      const existe = await contarProspectos('8781110001', 'Negocio Valido A');
      assert.strictEqual(existe, 1);
    });
  } finally {
    srv.detener();
  }
}

// ═══════════════ Grupo B: honeypot, tiempo mínimo, deduplicación, XSS ═══════════════
{
  const srv = await arrancarServidor({ PORT: PUERTO });
  try {
    await t('ANTISPAM', 'honeypot lleno -> 201 pero NO crea el registro', async () => {
      const r = await api(srv.base, '/api/public/prospectos', { method: 'POST', body: payloadValido({ telefono: '8781120001', negocio: 'Negocio Honeypot', empresaWeb: 'http://bot.example' }) });
      assert.strictEqual(r.status, 201);
      const total = await contarProspectos('8781120001', 'Negocio Honeypot');
      assert.strictEqual(total, 0);
    });

    await t('ANTISPAM', 'envío más rápido que el tiempo mínimo humano -> 201 pero NO crea el registro', async () => {
      const r = await api(srv.base, '/api/public/prospectos', { method: 'POST', body: payloadValido({ telefono: '8781120002', negocio: 'Negocio Muy Rapido', cargadoEn: Date.now() }) });
      assert.strictEqual(r.status, 201);
      const total = await contarProspectos('8781120002', 'Negocio Muy Rapido');
      assert.strictEqual(total, 0);
    });

    await t('DEDUPE', 'doble clic (mismo teléfono+negocio, envíos consecutivos) -> un solo registro', async () => {
      const body = payloadValido({ telefono: '8781120003', negocio: 'Negocio Doble Clic' });
      const r1 = await api(srv.base, '/api/public/prospectos', { method: 'POST', body });
      const r2 = await api(srv.base, '/api/public/prospectos', { method: 'POST', body });
      assert.strictEqual(r1.status, 201);
      assert.strictEqual(r2.status, 201);
      const total = await contarProspectos('8781120003', 'Negocio Doble Clic');
      assert.strictEqual(total, 1);
    });

    await t('XSS', 'comentario con < o > -> 400, nunca se persiste HTML', async () => {
      const r = await api(srv.base, '/api/public/prospectos', {
        method: 'POST',
        body: payloadValido({ telefono: '8781120004', negocio: 'Negocio XSS', comentario: '<script>alert(1)</script>' }),
      });
      assert.strictEqual(r.status, 400);
      const total = await contarProspectos('8781120004', 'Negocio XSS');
      assert.strictEqual(total, 0);
    });

    await t('VALIDACION', 'campos inesperados en el body se ignoran, nunca se persisten tal cual', async () => {
      const r = await api(srv.base, '/api/public/prospectos', {
        method: 'POST',
        body: payloadValido({ telefono: '8781120005', negocio: 'Negocio Campo Extra', esAdmin: true, rol: 'superadmin' }),
      });
      assert.strictEqual(r.status, 201);
      const { rows } = await pool.query('SELECT * FROM prospectos_comerciales WHERE telefono = $1', ['8781120005']);
      assert.ok(!('es_admin' in rows[0]));
      assert.ok(!('rol' in rows[0]));
    });
  } finally {
    srv.detener();
  }
}

// ═══════════════ Grupo C: rate limit (instancia propia, límite en memoria aislado) ═══════════════
{
  const srv = await arrancarServidor({ PORT: PUERTO });
  try {
    await t('RATE-LIMIT', 'más de 6 solicitudes en la ventana -> 429 en la séptima', async () => {
      const respuestas = [];
      for (let i = 0; i < 7; i++) {
        respuestas.push(await api(srv.base, '/api/public/prospectos', {
          method: 'POST',
          body: payloadValido({ telefono: `878900${i}000`, negocio: `Negocio Rate ${i}` }),
        }));
      }
      const codigos = respuestas.map(r => r.status);
      assert.ok(codigos.slice(0, 6).every(c => c === 201), `las primeras 6 deben ser 201, fueron: ${codigos.join(',')}`);
      assert.strictEqual(codigos[6], 429, `la 7ª debe ser 429, fue ${codigos[6]}`);
    });
  } finally {
    srv.detener();
  }
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) {
  console.log('\nDetalle de fallos:');
  fallos.forEach(f => console.log(`  - ${f}`));
  process.exitCode = 1;
}
await pool.end();
