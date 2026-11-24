// Pantalla del segundo factor en superadmin.html, manejada con un navegador
// real (Puppeteer): alta con contraseña → QR y clave → código de la app →
// consola abierta; y en una sesión nueva, solo el código. Solo base local.
import assert from 'assert';
import { randomUUID } from 'crypto';
import puppeteer from 'puppeteer';
import { arrancarServidor } from './lib-servidor.mjs';

const host = new URL(process.env.DATABASE_URL || 'postgres://x@nohost/x').hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`ABORTADO: fase-superadmin-2fa-ui solo corre contra una base local (DATABASE_URL apunta a ${host}).`);
  process.exit(1);
}
process.env.INTEGRATIONS_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.SESSION_SECRET ||= 'sesion-de-prueba-sa2fa';
const PUERTO = process.env.TEST_PORT_SA2FA_UI || '4762';

const { pool, crearUsuarioConPassword } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { codigoHotp, pasoActual, desdeBase32 } = await import('../src/services/superadmin2fa.js');

let pasadas = 0, fallidas = 0;
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; }
}

const { rows: [neg] } = await pool.query(`SELECT id FROM negocios WHERE activo ORDER BY created_at LIMIT 1`);
const sufijo = randomUUID().slice(0, 8);
const PASSWORD = `Clave-Ui-${sufijo}`;
const u = await crearUsuarioConPassword({ negocioId: neg.id, nombre: 'Sa2fa UI', email: `sa2fa-ui-${sufijo}@test.local`, password: PASSWORD, rol: 'admin' });
await pool.query(`INSERT INTO administradores_plataforma (usuario_id) VALUES ($1)`, [u.id]);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 40000 });
const navegador = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const visible = (p, sel) => p.$eval(sel, el => getComputedStyle(el).display !== 'none' && el.offsetParent !== null).catch(() => false);
async function pagina(token) {
  const p = await navegador.newPage();
  await p.setViewport({ width: 390, height: 800 });
  await p.setCookie({ name: 'xabor_sesion', value: encodeURIComponent(token), url: srv.base });
  await p.goto(srv.base + '/superadmin', { waitUntil: 'networkidle0' });
  return p;
}
let secreto = null;
try {
  await t('sesión nueva sin 2FA: pide contraseña para el alta, la consola no se ve', async () => {
    const p = await pagina(crearTokenSesion({ usuarioId: u.id, negocioId: neg.id, rol: 'admin' }));
    assert.ok(await visible(p, '#segundo-factor'), 'no aparece la pantalla del segundo factor');
    assert.ok(await visible(p, '#sf-password'), 'no pide la contraseña');
    assert.ok(!(await visible(p, '#app')), 'la consola quedó visible');

    await p.type('#sf-password', 'equivocada');
    await p.click('#sf-btn-alta');
    await p.waitForFunction(() => document.getElementById('sf-feedback').textContent.length > 0);
    assert.match(await p.$eval('#sf-feedback', e => e.textContent), /Contraseña incorrecta/);

    await p.$eval('#sf-password', e => { e.value = ''; });
    await p.type('#sf-password', PASSWORD);
    await p.click('#sf-btn-alta');
    await p.waitForSelector('#sf-qr img', { visible: true });
    secreto = await p.$eval('#sf-secreto', e => e.textContent);
    assert.match(secreto, /^[A-Z2-7]{32}$/);
    assert.ok(await visible(p, '#sf-codigo'), 'no pide el código');

    await p.type('#sf-codigo', codigoHotp(desdeBase32(secreto), pasoActual()));
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.click('#sf-btn-verificar')]);
    await p.waitForSelector('#app', { visible: true, timeout: 10000 });
    assert.ok(!(await visible(p, '#segundo-factor')), 'la pantalla del código sigue encima de la consola');
    await p.close();
  });

  await t('otra sesión del mismo usuario: solo pide el código (sin alta) y abre', async () => {
    const p = await pagina(crearTokenSesion({ usuarioId: u.id, negocioId: neg.id, rol: 'admin' }));
    assert.ok(await visible(p, '#sf-codigo'), 'no pide el código');
    assert.ok(!(await visible(p, '#sf-password')), 'volvió a ofrecer el alta');
    // El paso siguiente: el del paso actual ya se usó en el alta.
    await p.type('#sf-codigo', codigoHotp(desdeBase32(secreto), pasoActual() + 1));
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.click('#sf-btn-verificar')]);
    await p.waitForSelector('#app', { visible: true, timeout: 10000 });
    await p.close();
  });
} finally {
  await navegador.close();
  srv.detener();
  await pool.query('DELETE FROM superadmin_totp WHERE usuario_id = $1', [u.id]).catch(() => {});
  await pool.end().catch(() => {});
}
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) process.exit(1);
