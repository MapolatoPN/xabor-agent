// Autofactura nativa de Xabor — fase 1: modelo de datos + liga/token.
//
// Lo que esta suite demuestra, contra Postgres y sin tocar Facturapi ni Meta:
//   - el token es aleatorio de verdad (256 bits) y NUNCA queda en claro en la
//     base: solo su SHA-256 y su versión cifrada (AES-256-GCM, mismo helper que
//     las credenciales de integración);
//   - una venta = una liga: dos llamadas (incluso simultáneas) devuelven la
//     misma, y la base rechaza una segunda fila por (negocio_id, folio);
//   - solo una venta pagada obtiene liga; total congelado; TOTAL_CAMBIO;
//   - expirada / revocada / facturada se distinguen y una facturada jamás se
//     renueva;
//   - aislamiento estricto por negocio: otro negocio no ve ni reutiliza la venta.
//
// Uso: mismas env vars que la batería (DATABASE_URL local +
// INTEGRATIONS_ENCRYPTION_KEY). Requiere la migración 089 aplicada.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida (cifra el token)');
// La URL pública se toma del entorno del servidor (pagosService.urlPublicaXabor).
process.env.XABOR_URL_PUBLICA ||= 'https://autofactura.prueba.local';

const { pool } = await import('../src/services/database.js');
const {
  crearOObtenerAutofactura, resolverAutofacturaPorToken, obtenerAutofacturaPorVenta,
  renovarAutofactura, revocarAutofactura, VIGENCIA_DIAS, esFormatoTokenValido, hashTokenAutofactura,
} = await import('../src/services/autofacturaService.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

const { rows: negocios } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 2');
if (negocios.length < 2) throw new Error('La base local necesita al menos dos negocios de prueba');
const [NEG, NEG_B] = negocios.map((n) => n.id);
// Folios con sufijo de LETRAS: normalizarFolioFactura reescribe los que
// terminan en dígitos y la barrera de folios históricos reclama ^XAB-\d+$.
const PREFIJO = 'XAB-AFTEST';
const F = (s) => `${PREFIJO}-${s}`;

async function sembrarPedido(negocioId, folio, { estado = 'entregado', total = 150, pagoConfirmado = true, formaPago = 'efectivo' } = {}) {
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
     VALUES ($1,$2,$3,$4::jsonb, $5)
     ON CONFLICT (folio) DO UPDATE SET negocio_id=$1, estado=$3, datos=$4::jsonb, entregado_at=$5`,
    [negocioId, folio, estado, JSON.stringify({
      total, forma_pago: formaPago, pago_confirmado: pagoConfirmado, modalidad: 'recoger en tienda',
      cliente: { nombre: 'Cliente autofactura', telefono: '5218780000001' },
    }), estado === 'entregado' ? new Date() : null]);
}
async function fila(negocioId, folio) {
  const { rows: [r] } = await pool.query('SELECT * FROM autofacturas WHERE negocio_id=$1 AND folio=$2', [negocioId, folio]);
  return r || null;
}
async function rechaza(fn, codigo) {
  try { await fn(); } catch (e) { assert.equal(e.codigo, codigo, `esperaba ${codigo}, llegó ${e.codigo || e.message}`); return e; }
  assert.fail(`debía rechazar con ${codigo}`);
}
const limpiar = () => Promise.all([
  pool.query('DELETE FROM autofacturas WHERE folio LIKE $1', [`${PREFIJO}%`]),
  pool.query('DELETE FROM pedidos_activos WHERE folio LIKE $1', [`${PREFIJO}%`]),
]);
await limpiar();

try {

await t('1. el token tiene 256 bits de entropía y formato base64url exacto', async () => {
  const tokens = new Set();
  const letras = new Set();
  for (let i = 0; i < 100; i++) {
    await sembrarPedido(NEG, F(`ENT${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`));
  }
  for (let i = 0; i < 100; i++) {
    const folio = F(`ENT${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`);
    const { token } = await crearOObtenerAutofactura(NEG, folio);
    assert.ok(esFormatoTokenValido(token), `formato inesperado: ${token}`);
    assert.equal(Buffer.from(token, 'base64url').length, 32, 'el token decodifica a 32 bytes (256 bits)');
    tokens.add(token);
    for (const ch of token) letras.add(ch);
  }
  assert.equal(tokens.size, 100, 'cien tokens, cien valores distintos');
  assert.ok(letras.size >= 50, `alfabeto pobre en 100 tokens: ${letras.size} símbolos distintos`);
});

await t('2. el token crudo NO queda en texto plano en ninguna columna', async () => {
  await sembrarPedido(NEG, F('PLANO'));
  const { token } = await crearOObtenerAutofactura(NEG, F('PLANO'));
  const r = await fila(NEG, F('PLANO'));
  for (const [col, v] of Object.entries(r)) {
    if (typeof v === 'string') assert.ok(!v.includes(token), `la columna ${col} contiene el token en claro`);
  }
  assert.ok(r.token_cifrado && r.token_iv && r.token_auth_tag && r.token_formato_version === 1, 'token cifrado con formato v1');
  assert.notEqual(r.token_cifrado, token);
});

await t('3. el hash almacenado es SHA-256 del token y la liga se reconstruye desde el cifrado', async () => {
  const { token, url } = await crearOObtenerAutofactura(NEG, F('PLANO'));
  const r = await fila(NEG, F('PLANO'));
  assert.equal(r.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(r.token_hash, hashTokenAutofactura(token));
  assert.equal(url, `${process.env.XABOR_URL_PUBLICA}/f/${token}`);
  // Reimpresión: desde la base, sin conocer el token, se obtiene la MISMA liga.
  const reimpresa = await obtenerAutofacturaPorVenta(NEG, F('PLANO'));
  assert.equal(reimpresa.token, token);
  assert.equal(reimpresa.url, url);
});

await t('4. mismo negocio + folio devuelve la MISMA liga, sin segunda fila', async () => {
  await sembrarPedido(NEG, F('MISMA'));
  const a = await crearOObtenerAutofactura(NEG, F('MISMA'));
  const b = await crearOObtenerAutofactura(NEG, F('MISMA'));
  assert.equal(a.creada, true); assert.equal(b.creada, false);
  assert.equal(a.token, b.token); assert.equal(a.url, b.url); assert.equal(a.id, b.id);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM autofacturas WHERE negocio_id=$1 AND folio=$2', [NEG, F('MISMA')]);
  assert.equal(n, 1);
});

await t('5. otro negocio no puede resolver ni reutilizar la venta', async () => {
  const propia = await crearOObtenerAutofactura(NEG, F('MISMA'));
  await rechaza(() => crearOObtenerAutofactura(NEG_B, F('MISMA')), 'PEDIDO_NO_ENCONTRADO');
  assert.equal(await obtenerAutofacturaPorVenta(NEG_B, F('MISMA')), null);
  await rechaza(() => renovarAutofactura(NEG_B, F('MISMA')), 'AUTOFACTURA_NO_ENCONTRADA');
  await rechaza(() => revocarAutofactura(NEG_B, F('MISMA')), 'AUTOFACTURA_NO_ENCONTRADA');
  const publica = await resolverAutofacturaPorToken(propia.token);
  assert.equal(publica.negocioId, NEG, 'el token resuelve al negocio dueño, no al que pregunta');
  assert.equal(publica.estado, 'vigente');
});

await t('6. una venta no pagada no obtiene liga', async () => {
  await sembrarPedido(NEG, F('NOPAGO'), { estado: 'en_preparacion', pagoConfirmado: false });
  await rechaza(() => crearOObtenerAutofactura(NEG, F('NOPAGO')), 'PEDIDO_NO_PAGADO');
  assert.equal(await fila(NEG, F('NOPAGO')), null);
});

await t('7. una venta cancelada no obtiene liga', async () => {
  await sembrarPedido(NEG, F('CANCEL'), { estado: 'cancelado' });
  await rechaza(() => crearOObtenerAutofactura(NEG, F('CANCEL')), 'PEDIDO_CANCELADO');
  assert.equal(await fila(NEG, F('CANCEL')), null);
});

await t('8. total <= 0 se rechaza', async () => {
  await sembrarPedido(NEG, F('CERO'), { total: 0 });
  await rechaza(() => crearOObtenerAutofactura(NEG, F('CERO')), 'TOTAL_NO_FACTURABLE');
  assert.equal(await fila(NEG, F('CERO')), null);
});

await t('9. el total queda congelado al crear la liga', async () => {
  await sembrarPedido(NEG, F('CONGELA'), { total: 150 });
  const a = await crearOObtenerAutofactura(NEG, F('CONGELA'));
  assert.equal(a.total, 150);
  await pool.query(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{total}', '175') WHERE folio=$1`, [F('CONGELA')]);
  const guardada = await obtenerAutofacturaPorVenta(NEG, F('CONGELA'));
  assert.equal(guardada.total, 150, 'la liga conserva el total con el que se creó');
  assert.equal(Number((await fila(NEG, F('CONGELA'))).total), 150);
});

await t('10. si la venta cambia de total, crear y renovar responden TOTAL_CAMBIO', async () => {
  await rechaza(() => crearOObtenerAutofactura(NEG, F('CONGELA')), 'TOTAL_CAMBIO');
  await rechaza(() => renovarAutofactura(NEG, F('CONGELA')), 'TOTAL_CAMBIO');
  assert.equal((await fila(NEG, F('CONGELA'))).estado, 'vigente', 'un TOTAL_CAMBIO no altera la fila');
});

await t('11. un token inventado o malformado no resuelve (y el malformado ni toca la base)', async () => {
  const inventado = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url');
  assert.equal(await resolverAutofacturaPorToken(inventado), null);
  const original = pool.query;
  let consultas = 0;
  pool.query = (...a) => { consultas++; return original.apply(pool, a); };
  try {
    assert.equal(await resolverAutofacturaPorToken('XAB-0001'), null);
    assert.equal(await resolverAutofacturaPorToken(''), null);
    assert.equal(await resolverAutofacturaPorToken(null), null);
    assert.equal(await resolverAutofacturaPorToken("' OR 1=1 --"), null);
  } finally { pool.query = original; }
  assert.equal(consultas, 0, 'un token con formato inválido nunca llega a Postgres');
});

await t('12. una liga vencida se reporta expirada (y se persiste)', async () => {
  await sembrarPedido(NEG, F('VENCE'));
  const { token } = await crearOObtenerAutofactura(NEG, F('VENCE'));
  await pool.query(`UPDATE autofacturas SET expires_at = now() - interval '1 day' WHERE negocio_id=$1 AND folio=$2`, [NEG, F('VENCE')]);
  const r = await resolverAutofacturaPorToken(token);
  assert.equal(r.estado, 'expirada');
  assert.equal((await fila(NEG, F('VENCE'))).estado, 'expirada');
  const otraVez = await crearOObtenerAutofactura(NEG, F('VENCE'));
  assert.equal(otraVez.estado, 'expirada', 'crearOObtener no renueva por su cuenta');
  assert.equal(otraVez.token, token, 'ni genera otra liga');
});

await t('13. una liga revocada se reporta revocada', async () => {
  await sembrarPedido(NEG, F('REVOCA'));
  const { token } = await crearOObtenerAutofactura(NEG, F('REVOCA'));
  const rev = await revocarAutofactura(NEG, F('REVOCA'));
  assert.equal(rev.estado, 'revocada');
  assert.ok(!('token' in rev) && !('token_hash' in rev), 'la vista de revocación no trae secretos');
  assert.equal((await resolverAutofacturaPorToken(token)).estado, 'revocada');
  assert.equal((await crearOObtenerAutofactura(NEG, F('REVOCA'))).estado, 'revocada');
  assert.equal((await revocarAutofactura(NEG, F('REVOCA'))).estado, 'revocada', 'revocar dos veces es idempotente');
});

await t('14. renovar invalida el token anterior', async () => {
  await sembrarPedido(NEG, F('RENUEVA'));
  const antes = await crearOObtenerAutofactura(NEG, F('RENUEVA'));
  await pool.query(`UPDATE autofacturas SET expires_at = now() - interval '1 hour' WHERE negocio_id=$1 AND folio=$2`, [NEG, F('RENUEVA')]);
  assert.equal((await resolverAutofacturaPorToken(antes.token)).estado, 'expirada');
  const despues = await renovarAutofactura(NEG, F('RENUEVA'));
  assert.equal(await resolverAutofacturaPorToken(antes.token), null, 'el token viejo ya no resuelve');
  assert.equal((await resolverAutofacturaPorToken(despues.token)).estado, 'vigente');
});

await t('15. renovar produce token nuevo, misma fila y otros 30 días', async () => {
  const actual = await obtenerAutofacturaPorVenta(NEG, F('RENUEVA'));
  const r = await renovarAutofactura(NEG, F('RENUEVA'));
  assert.notEqual(r.token, actual.token);
  assert.equal(r.id, actual.id, 'renovar no crea otra fila');
  assert.equal(r.estado, 'vigente');
  const dias = (new Date(r.expiresAt).getTime() - Date.now()) / 86400000;
  assert.ok(dias > VIGENCIA_DIAS - 0.01 && dias <= VIGENCIA_DIAS, `vigencia de ${dias.toFixed(2)} días`);
  const db = await fila(NEG, F('RENUEVA'));
  assert.equal(db.token_hash, hashTokenAutofactura(r.token));
  assert.equal((await obtenerAutofacturaPorVenta(NEG, F('RENUEVA'))).token, r.token, 'la reimpresión ya da el token nuevo');
});

await t('16. una autofactura facturada no se renueva ni se revoca; se devuelve tal cual', async () => {
  await sembrarPedido(NEG, F('FACTURADA'));
  const { token } = await crearOObtenerAutofactura(NEG, F('FACTURADA'));
  await pool.query(
    `UPDATE autofacturas SET estado='facturada', factura_id='inv_prueba_af', uuid='11111111-2222-3333-4444-555555555555',
       emitida_at=now(), fuente_emision='portal' WHERE negocio_id=$1 AND folio=$2`, [NEG, F('FACTURADA')]);
  await rechaza(() => renovarAutofactura(NEG, F('FACTURADA')), 'AUTOFACTURA_FACTURADA');
  await rechaza(() => revocarAutofactura(NEG, F('FACTURADA')), 'AUTOFACTURA_FACTURADA');
  const r = await crearOObtenerAutofactura(NEG, F('FACTURADA'));
  assert.equal(r.estado, 'facturada'); assert.equal(r.token, token); assert.equal(r.uuid, '11111111-2222-3333-4444-555555555555');
  const publica = await resolverAutofacturaPorToken(token);
  assert.equal(publica.estado, 'facturada'); assert.equal(publica.facturaId, 'inv_prueba_af');
  assert.equal(hashTokenAutofactura(token), (await fila(NEG, F('FACTURADA'))).token_hash, 'el token no cambió');
});

await t('17. seis crearOObtener simultáneos terminan con UNA sola fila y la misma liga', async () => {
  await sembrarPedido(NEG, F('CARRERA'));
  const resultados = await Promise.all(Array.from({ length: 6 }, () => crearOObtenerAutofactura(NEG, F('CARRERA'))));
  const tokens = new Set(resultados.map((r) => r.token));
  assert.equal(tokens.size, 1, `se repartieron ${tokens.size} ligas distintas`);
  assert.equal(resultados.filter((r) => r.creada).length, 1, 'exactamente una llamada creó la fila');
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM autofacturas WHERE negocio_id=$1 AND folio=$2', [NEG, F('CARRERA')]);
  assert.equal(n, 1);
});

await t('18. la base rechaza una segunda fila para el mismo negocio+folio', async () => {
  const r = await fila(NEG, F('CARRERA'));
  await assert.rejects(
    () => pool.query(
      `INSERT INTO autofacturas (negocio_id, folio, token_hash, token_cifrado, token_iv, token_auth_tag, total, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '30 days')`,
      [NEG, F('CARRERA'), 'a'.repeat(64), r.token_cifrado, r.token_iv, r.token_auth_tag, 150]),
    /duplicate key value violates unique constraint/);
});

await t('19. ningún negocio lee una autofactura ajena por folio', async () => {
  // NEG_B tiene su PROPIA venta con un folio distinto; la de NEG no se le asoma.
  await sembrarPedido(NEG_B, F('AJENA'));
  const deB = await crearOObtenerAutofactura(NEG_B, F('AJENA'));
  assert.equal(await obtenerAutofacturaPorVenta(NEG, F('AJENA')), null);
  assert.equal(await obtenerAutofacturaPorVenta(NEG_B, F('CARRERA')), null);
  await rechaza(() => revocarAutofactura(NEG, F('AJENA')), 'AUTOFACTURA_NO_ENCONTRADA');
  const { rows } = await pool.query('SELECT negocio_id FROM autofacturas WHERE folio LIKE $1', [`${PREFIJO}%`]);
  assert.ok(rows.every((x) => x.negocio_id === NEG || x.negocio_id === NEG_B));
  assert.equal((await resolverAutofacturaPorToken(deB.token)).negocioId, NEG_B);
});

} finally {
  await limpiar();
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
