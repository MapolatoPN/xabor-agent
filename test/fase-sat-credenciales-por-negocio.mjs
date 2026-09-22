// ─── E.FIRMA SAT: POR NEGOCIO, Y QUE DE VERDAD FUNCIONE ───────────────────
//
// `configuracion` tiene `negocio_id` en su llave primaria COMPUESTA
// `(negocio_id, clave)` desde hace tiempo. `satCredentials.js` seguía
// escribiendo `INSERT INTO configuracion (clave, valor) ... ON CONFLICT
// (clave)`, que nunca coincidió con esa restricción real: **cada llamada a
// guardarCredencialesSAT lanzaba**, y ninguna e.firma llegó jamás a
// guardarse, para ningún negocio. No era una fuga entre negocios — era una
// función completamente rota, descubierta al auditar por qué el chip de
// Config prometía «e.firma cargada» sin que nadie hubiera podido cargar una.
//
// Esta suite fija dos cosas: que la función por fin funcione, y que lo haga
// por negocio — la garantía que el resto del módulo de facturación ya tiene.
//
// Uso: DATABASE_URL a un Postgres LOCAL (se niega con cualquier otro).
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const HOST = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
  throw new Error('Esta prueba escribe credenciales SAT: solo acepta Postgres local');
}
if (!process.env.PANEL_SECRET && !process.env.ADMIN_PASSWORD) {
  // `derivarClaveCifrado()` lo exige; sin uno de los dos la suite no puede
  // ejercitar el cifrado real y fallaría por una razón ajena a lo que prueba.
  process.env.PANEL_SECRET = 'clave-de-prueba-fase-sat-credenciales';
}

let pasadas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
}

const { pool } = await import('../src/services/database.js');
const { guardarCredencialesSAT, cargarCredencialesSATdb, obtenerInfoCertSAT, eliminarCredencialesSAT } =
  await import('../src/services/satCredentials.js');

const { rows: negocios } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 2');
if (negocios.length < 2) throw new Error('La base local necesita al menos dos negocios de prueba');
const [A, B] = negocios.map((n) => n.id);

const limpiar = () => Promise.all([
  eliminarCredencialesSAT(A).catch(() => {}),
  eliminarCredencialesSAT(B).catch(() => {}),
]);
await limpiar();

const CRED_A = { certBase64: 'AAAA-cert-negocio-A', privateKeyPem: 'llave-privada-negocio-A',
  certInfo: { rfc: 'AAAA010101AAA', serial: '111' } };
const CRED_B = { certBase64: 'BBBB-cert-negocio-B', privateKeyPem: 'llave-privada-negocio-B',
  certInfo: { rfc: 'BBBB020202BBB', serial: '222' } };

try {

await t('S1 sin negocioId, guardar LANZA — no hay a quién servir', async () => {
  await assert.rejects(() => guardarCredencialesSAT(null, CRED_A), /negocioId requerido/);
  await assert.rejects(() => guardarCredencialesSAT('', CRED_A), /negocioId requerido/);
});

await t('S2 LA GARANTÍA DE FONDO: guardar ya no revienta contra el esquema real', async () => {
  // Esta es la prueba de regresión del defecto real: antes de este arreglo,
  // esta misma llamada lanzaba "no unique or exclusion constraint matching
  // the ON CONFLICT specification" el cien por ciento de las veces.
  await assert.doesNotReject(() => guardarCredencialesSAT(A, CRED_A));
});

await t('S3 lo que se guarda es lo que se lee, cifrado de por medio', async () => {
  const db = await cargarCredencialesSATdb(A);
  assert.equal(db.certBase64, CRED_A.certBase64);
  assert.equal(db.privateKeyPem, CRED_A.privateKeyPem, 'la llave privada no descifró igual a como se guardó');

  const info = await obtenerInfoCertSAT(A);
  assert.equal(info.rfc, CRED_A.certInfo.rfc);
  assert.equal(info.serial, CRED_A.certInfo.serial);
});

await t('S4 la llave privada NUNCA aparece en el metadato público', async () => {
  const info = await obtenerInfoCertSAT(A);
  assert.equal(JSON.stringify(info).includes(CRED_A.privateKeyPem), false,
    'obtenerInfoCertSAT (lo que ve el panel) filtró la llave privada');
});

await t('S5 LA GARANTÍA MULTIEMPRESA: la e.firma de un negocio no se asoma a otro', async () => {
  await guardarCredencialesSAT(B, CRED_B);

  const infoA = await obtenerInfoCertSAT(A);
  const infoB = await obtenerInfoCertSAT(B);
  assert.equal(infoA.rfc, CRED_A.certInfo.rfc);
  assert.equal(infoB.rfc, CRED_B.certInfo.rfc);
  assert.notEqual(infoA.rfc, infoB.rfc, 'los dos negocios leyeron la misma ficha');

  const dbA = await cargarCredencialesSATdb(A);
  const dbB = await cargarCredencialesSATdb(B);
  assert.equal(dbA.privateKeyPem, CRED_A.privateKeyPem);
  assert.equal(dbB.privateKeyPem, CRED_B.privateKeyPem);
  assert.notEqual(dbA.privateKeyPem, dbB.privateKeyPem, 'los dos negocios leyeron la misma llave privada');
});

await t('S6 eliminar es POR NEGOCIO: borrar la de A no toca la de B', async () => {
  await eliminarCredencialesSAT(A);
  assert.equal(await cargarCredencialesSATdb(A), null, 'A conservó credenciales que debían borrarse');
  const dbB = await cargarCredencialesSATdb(B);
  assert.equal(dbB?.privateKeyPem, CRED_B.privateKeyPem,
    'borrar las credenciales de A se llevó también las de B — exactamente el bug original, del otro lado');
});

await t('S7 sin negocioId, leer y borrar también LANZAN', async () => {
  await assert.rejects(() => cargarCredencialesSATdb(null), /negocioId requerido/);
  await assert.rejects(() => obtenerInfoCertSAT(undefined), /negocioId requerido/);
  await assert.rejects(() => eliminarCredencialesSAT(''), /negocioId requerido/);
});

} finally {
  await limpiar();
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
