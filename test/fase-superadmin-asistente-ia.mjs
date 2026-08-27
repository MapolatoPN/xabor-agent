// Superadmin administra Vision y el giro SIN SQL manual y SIN deploy.
//
// La UI/endpoints NO crean una fuente de verdad nueva: leen y escriben las
// MISMAS claves de `configuracion` (vision_imagenes / giro) que consume el
// motor de Vision por turno. Sin fila: OFF (fail closed, igual que
// visionHabilitada). El catálogo de giros es sugerencia de UI, no un ENUM.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      node test/fase-superadmin-asistente-ia.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4297';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const cookie = (usuarioId, negocioId, rol = 'admin') =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

const NEG_A = SEED.negocioA, NEG_B = SEED.negocioB;
const SUPER = SEED.superadminUsuarioId;
const ADMIN_A = SEED.adminNegocioAUsuarioId;   // admin normal, NO superadmin
const STAFF_A = SEED.staffNegocioAUsuarioId;

// Estado limpio: sin filas de vision/giro en A y B; chat_imagenes activo en A.
await pool.query(`DELETE FROM configuracion WHERE negocio_id = ANY($1) AND clave IN ('vision_imagenes','giro')`, [[NEG_A, NEG_B]]);
await pool.query(
  `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'chat_imagenes','activo')
   ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [NEG_A]);

const srv = await arrancarServidor({ PORT: PUERTO, OPENAI_API_KEY: '' }, { timeoutMs: 30000 });
const BASE = srv.base;

const api = (path, { metodo = 'GET', body, quien = 'super' } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (quien === 'super') headers.Cookie = cookie(SUPER, NEG_A);
  else if (quien === 'admin') headers.Cookie = cookie(ADMIN_A, NEG_A);
  else if (quien === 'staff') headers.Cookie = cookie(STAFF_A, NEG_A, 'staff');
  return fetch(BASE + path, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
};
const filasCfg = async (negocioId, clave) => (await pool.query(
  `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [negocioId, clave])).rows;

// ═══ A14: los 18 casos ══════════════════════════════════════════════════════
await t('1. negocio sin fila vision_imagenes → OFF (fail closed)', async () => {
  const r = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`);
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.vision, false, 'sin fila el default es OFF');
  assert.strictEqual(d.giro, null);
  assert.ok(Array.isArray(d.girosSugeridos) && d.girosSugeridos.length >= 7, 'el catálogo de giros viaja para la UI');
});

await t('2. ON crea/upsertea la fila con true', async () => {
  const r = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: true } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).vision, true);
  const filas = await filasCfg(NEG_A, 'vision_imagenes');
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].valor, 'true');
});

await t('3. OFF guarda false (no borra: queda explícito)', async () => {
  const r = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: false } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).vision, false);
  assert.strictEqual((await filasCfg(NEG_A, 'vision_imagenes'))[0].valor, 'false');
});

await t('4. muchos PATCH no duplican la fila de configuracion', async () => {
  for (const v of [true, false, true, false, true]) {
    await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: v } });
  }
  assert.strictEqual((await filasCfg(NEG_A, 'vision_imagenes')).length, 1, 'upsert por (negocio_id, clave), jamás duplicados');
});

await t('5. giro existente se muestra', async () => {
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'giro','floreria_eventos')
                    ON CONFLICT (negocio_id, clave) DO UPDATE SET valor='floreria_eventos'`, [NEG_A]);
  const d = await (await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`)).json();
  assert.strictEqual(d.giro, 'floreria_eventos');
});

await t('6. giro se actualiza (incluye giro personalizado fuera del catálogo)', async () => {
  const r = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { giro: 'pasteleria' } });
  assert.strictEqual((await r.json()).giro, 'pasteleria');
  const r2 = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { giro: 'viveros_y_jardines' } });
  assert.strictEqual((await r2.json()).giro, 'viveros_y_jardines', 'un slug limpio nuevo es válido: el catálogo no limita el futuro');
});

await t('7. giro vacío permitido: limpia la configuración', async () => {
  const r = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { giro: '' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).giro, null);
  assert.strictEqual((await filasCfg(NEG_A, 'giro')).length, 0, 'sin giro no queda fila fantasma');
});

await t('8. Vision ON + sin giro es un estado válido (modo universal)', async () => {
  await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: true } });
  const d = await (await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`)).json();
  assert.strictEqual(d.vision, true);
  assert.strictEqual(d.giro, null);
});

await t('9/12. tenant isolation: cambiar A no altera B', async () => {
  await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: true, giro: 'restaurante' } });
  const dB = await (await api(`/api/superadmin/negocios/${NEG_B}/asistente-ia`)).json();
  assert.strictEqual(dB.vision, false, 'B sigue OFF');
  assert.strictEqual(dB.giro, null, 'B sigue sin giro');
  assert.strictEqual((await filasCfg(NEG_B, 'vision_imagenes')).length, 0);
});

await t('10. admin normal y staff NO pueden tocar el asistente IA', async () => {
  for (const quien of ['admin', 'staff']) {
    const g = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { quien });
    assert.ok([401, 403].includes(g.status), `GET como ${quien} respondió ${g.status}`);
    const p = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: false }, quien });
    assert.ok([401, 403].includes(p.status), `PATCH como ${quien} respondió ${p.status}`);
  }
  assert.strictEqual((await filasCfg(NEG_A, 'vision_imagenes'))[0].valor, 'true', 'nadie sin permiso cambió nada');
});

await t('11. valores inválidos rechazados con 400', async () => {
  for (const body of [{ vision: 'admin' }, { vision: 1 }, { giro: 'MAYUSCULAS' }, { giro: '200%' }, { giro: 'x' }, { giro: 'a'.repeat(50) }, {}]) {
    const r = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body });
    assert.strictEqual(r.status, 400, `${JSON.stringify(body)} debió ser 400 y fue ${r.status}`);
  }
});

await t('13. refresh conserva estado (dos GET consecutivos idénticos)', async () => {
  const a = await (await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`)).json();
  const b = await (await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`)).json();
  assert.deepStrictEqual(a, b);
});

await t('14. la ficha del negocio y el asistente cargan juntos sin conflicto', async () => {
  const [rNeg, rIa] = await Promise.all([
    api(`/api/superadmin/negocios/${NEG_A}`),
    api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`),
  ]);
  assert.strictEqual(rNeg.status, 200);
  assert.strictEqual(rIa.status, 200);
});

await t('15. chat_imagenes y whatsapp viajan como estado read-only', async () => {
  const d = await (await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`)).json();
  assert.strictEqual(d.chatImagenes, 'activo', 'el módulo sembrado se refleja');
  assert.ok(typeof d.whatsapp === 'string');
  // Y en la UI son texto, no controles editables:
  const HTML = readFileSync(join(RAIZ, 'panel', 'superadmin.html'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/id="dt-ia-chatimg"/.test(HTML) && !/dt-ia-chatimg"[^>]*onchange/.test(HTML));
});

await t('16. contrato UI: un error del backend no deja el switch mintiendo', async () => {
  const HTML = readFileSync(join(RAIZ, 'panel', 'superadmin.html'), 'utf8').replace(/\r\n/g, '\n');
  const fn = HTML.slice(HTML.indexOf('async function cambiarVisionIA'), HTML.indexOf('async function guardarGiroIA'));
  assert.ok(/if \(!r\.ok\)[\s\S]*?cargarAsistenteIA\(negocioActualId\)/.test(fn), 'tras un error se recarga el estado real');
  assert.ok(/catch[\s\S]*?cargarAsistenteIA\(negocioActualId\)/.test(fn), 'también tras un fallo de red');
});

await t('17. contrato UI + backend: doble click no duplica el write', async () => {
  const HTML = readFileSync(join(RAIZ, 'panel', 'superadmin.html'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/if \(iaGuardando\) return;/.test(HTML), 'candado de guardado en la UI');
  // Y aunque llegaran dos PATCH, el upsert deja UNA fila:
  await Promise.all([
    api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: true } }),
    api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: true } }),
  ]);
  assert.strictEqual((await filasCfg(NEG_A, 'vision_imagenes')).length, 1);
});

await t('18. concurrencia básica: PATCH opuestos simultáneos terminan consistentes', async () => {
  const [r1, r2] = await Promise.all([
    api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: true } }),
    api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, { metodo: 'PATCH', body: { vision: false } }),
  ]);
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r2.status, 200);
  const filas = await filasCfg(NEG_A, 'vision_imagenes');
  assert.strictEqual(filas.length, 1, 'FOR UPDATE serializa: jamás filas duplicadas');
  assert.ok(['true', 'false'].includes(filas[0].valor), 'el valor final es uno de los dos, nunca basura');
});

// ═══ A15: adversarial ═══════════════════════════════════════════════════════
await t('ADV1. sin sesión → 401', async () => {
  const r = await fetch(`${BASE}/api/superadmin/negocios/${NEG_A}/asistente-ia`);
  assert.strictEqual(r.status, 401);
});

await t('ADV2. negocio inexistente → 404, sin crear nada', async () => {
  const fake = '00000000-0000-4000-8000-000000000000';
  const r = await api(`/api/superadmin/negocios/${fake}/asistente-ia`, { metodo: 'PATCH', body: { vision: true } });
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await filasCfg(fake, 'vision_imagenes')).length, 0);
});

await t('ADV3. claves arbitrarias en el body se IGNORAN: solo vision/giro se escriben', async () => {
  const { rows: [antes] } = await pool.query(`SELECT COUNT(*)::int AS n FROM configuracion WHERE negocio_id = $1`, [NEG_A]);
  const r = await api(`/api/superadmin/negocios/${NEG_A}/asistente-ia`, {
    metodo: 'PATCH', body: { vision: true, clave: 'anthropic_api_key', valor: 'robado', nombre: 'hackeado', horario: 'x' },
  });
  assert.strictEqual(r.status, 200);
  const { rows: [despues] } = await pool.query(`SELECT COUNT(*)::int AS n FROM configuracion WHERE negocio_id = $1`, [NEG_A]);
  assert.strictEqual(despues.n, antes.n, 'ninguna clave extra fue escrita');
  const { rows: nombre } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'nombre'`, [NEG_A]);
  assert.ok(!nombre.length || nombre[0].valor !== 'hackeado');
});

await t('ADV4. el cambio queda auditado con el actor real', async () => {
  const { rows } = await pool.query(
    `SELECT accion, estado_nuevo FROM auditoria_plataforma
      WHERE negocio_id = $1 AND accion = 'cambiar_asistente_ia' ORDER BY created_at DESC LIMIT 1`, [NEG_A]);
  assert.ok(rows.length, 'debe existir el rastro de auditoría (mismo mecanismo que estado/plan)');
});

srv.detener();
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
