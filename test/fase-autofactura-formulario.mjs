// Autofactura nativa de Xabor — fase 3: formulario fiscal + validación en el
// backend, SIN emisión, SIN Facturapi, SIN persistir datos fiscales.
//
// Servidor REAL (lib-servidor.mjs) contra Postgres local y navegador real
// (puppeteer) para el recorrido del cliente: formulario -> Continuar ->
// "Confirma tus datos" -> Corregir (valores conservados) -> Confirmar datos
// (mensaje de la fase, sin timbrar, sin cambiar el estado de la liga).
import assert from 'node:assert/strict';
import { arrancarServidor } from './lib-servidor.mjs';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');

const PUERTO = process.env.TEST_PORT || '4198';
const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { crearOObtenerAutofactura, revocarAutofactura } = await import('../src/services/autofacturaService.js');
const { REGIMENES_SAT, USOS_CFDI_SAT } = await import('../src/services/catalogosSat.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

const { rows: negocios } = await pool.query('SELECT id FROM negocios ORDER BY created_at LIMIT 2');
if (negocios.length < 2) throw new Error('La base local necesita al menos dos negocios de prueba');
const [NEG, NEG_B] = negocios.map((n) => n.id);
const PREFIJO = 'XAB-AFFORM';
const F = (s) => `${PREFIJO}-${s}`;
const NOMBRE_A = 'Negocio Formulario Fiscal';

// Datos válidos de referencia (RFC de prueba con formato correcto, no genérico).
const MORAL = { rfc: 'ABC010101AB1', nombre: 'Empresa de Prueba SA de CV', cp: '26000', regimen: '601', uso_cfdi: 'G03', email: 'facturas@empresa-prueba.test' };
const FISICA = { rfc: 'GOMJ800101ABC', nombre: 'Juan Gómez Pérez', cp: '26000', regimen: '612', uso_cfdi: 'G03', email: 'juan@correo-prueba.test' };

const filaUnica = async (sql, p) => (await pool.query(sql, p)).rows[0] || null;
const previo = {};
for (const n of [NEG, NEG_B]) {
  previo[n] = {
    activo: (await filaUnica('SELECT activo FROM negocios WHERE id=$1', [n])).activo,
    modulo: (await filaUnica(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [n]))?.estado ?? null,
    config: Object.fromEntries((await pool.query(
      `SELECT clave, valor FROM configuracion WHERE negocio_id=$1 AND clave IN ('nombre','logo_url')`, [n])).rows.map((r) => [r.clave, r.valor])),
  };
}
async function fijarModulo(negocioId, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion',$2)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado=$2`, [negocioId, estado]);
}
async function sembrarPedido(negocioId, folio, { total = 150 } = {}) {
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, entregado_at)
     VALUES ($1,$2,'entregado',$3::jsonb, NOW())
     ON CONFLICT (folio) DO UPDATE SET negocio_id=$1, estado='entregado', datos=$3::jsonb, entregado_at=NOW()`,
    [negocioId, folio, JSON.stringify({
      total, forma_pago: 'efectivo', pago_confirmado: true, modalidad: 'recoger en tienda', timestamp: '2026-09-21T15:00:00.000Z',
      cliente: { nombre: 'Cliente Formulario', telefono: '5218780000003' },
    })]);
}
async function ligaNueva(negocioId, sufijo, opts) {
  await sembrarPedido(negocioId, F(sufijo), opts);
  return crearOObtenerAutofactura(negocioId, F(sufijo));
}
const limpiar = () => Promise.all([
  pool.query('DELETE FROM autofacturas WHERE folio LIKE $1', [`${PREFIJO}%`]),
  pool.query('DELETE FROM pedidos_activos WHERE folio LIKE $1', [`${PREFIJO}%`]),
  pool.query('DELETE FROM clientes_fiscales WHERE negocio_id = ANY($1) AND rfc = ANY($2)', [[NEG, NEG_B], [MORAL.rfc, FISICA.rfc]]),
]);
await limpiar();
await pool.query('UPDATE negocios SET activo=TRUE WHERE id = ANY($1)', [[NEG, NEG_B]]);
await fijarModulo(NEG, 'activo'); await fijarModulo(NEG_B, 'activo');
await actualizarConfiguracion({ nombre: NOMBRE_A, logo_url: '' }, NEG);

const srv = await arrancarServidor({ PORT: PUERTO, XABOR_AUTOFACTURA_LIMITE_LECTURA: '500', XABOR_AUTOFACTURA_LIMITE_VALIDAR: '500' }, { timeoutMs: 30000 });
const base = srv.base;
const get = async (token) => { const r = await fetch(`${base}/api/autofactura/${token}`); const texto = await r.text(); return { status: r.status, json: JSON.parse(texto), texto }; };
const validar = async (token, body, opts = {}) => {
  const r = await fetch(`${base}/api/autofactura/${token}/validar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* no JSON */ }
  return { status: r.status, json, texto };
};
const filaAf = (negocioId, folio) => filaUnica('SELECT * FROM autofacturas WHERE negocio_id=$1 AND folio=$2', [negocioId, folio]);

let browser = null;
let liga;
try {

liga = await ligaNueva(NEG, 'OK');

await t('1. el formulario se muestra solo cuando la liga está vigente', async () => {
  const puppeteer = (await import('puppeteer')).default;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 20000 });
  const page = await browser.newPage(); page.setDefaultTimeout(15000);
  await page.setRequestInterception(true);
  page.on('request', (req) => (req.url().startsWith(base) ? req.continue() : req.abort()));
  await page.goto(`${base}/f/${liga.token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#af-rfc');
  for (const id of ['af-rfc', 'af-nombre', 'af-cp', 'af-regimen', 'af-uso_cfdi', 'af-email', 'af-continuar']) {
    assert.ok(await page.$('#' + id), `falta #${id}`);
  }
  assert.ok((await page.evaluate(() => document.getElementById("app").textContent)).includes('Debe coincidir exactamente con tu Constancia de Situación Fiscal.'));
  const exp = await ligaNueva(NEG, 'EXPFORM');
  await pool.query(`UPDATE autofacturas SET expires_at = now() - interval '1 day' WHERE negocio_id=$1 AND folio=$2`, [NEG, F('EXPFORM')]);
  await page.goto(`${base}/f/${exp.token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById("app").textContent.includes('Esta liga de facturación ha expirado.'));
  assert.equal(await page.$('#af-rfc'), null, 'una liga expirada no muestra formulario');
  await page.close();
});

await t('2. los catálogos de régimen y uso de CFDI llegan desde el backend', async () => {
  const r = await get(liga.token);
  assert.equal(r.status, 200);
  assert.equal(r.json.catalogos.regimenes.length, REGIMENES_SAT.length);
  assert.equal(r.json.catalogos.usos_cfdi.length, USOS_CFDI_SAT.length);
  assert.ok(r.json.catalogos.regimenes.length >= 19 && r.json.catalogos.usos_cfdi.length >= 24, 'catálogos SAT completos');
  for (const o of r.json.catalogos.regimenes) assert.deepEqual(Object.keys(o).sort(), ['clave', 'fisica', 'moral', 'nombre']);
  for (const o of r.json.catalogos.usos_cfdi) {
    assert.deepEqual(Object.keys(o).sort(), ['clave', 'fisica', 'moral', 'nombre', 'regimenes']);
    assert.ok(Array.isArray(o.regimenes) && o.regimenes.length > 0, `el uso ${o.clave} no trae regímenes permitidos`);
  }
  assert.ok(r.json.catalogos.regimenes.some((x) => x.clave === '626') && r.json.catalogos.usos_cfdi.some((x) => x.clave === 'S01'));
  assert.equal(r.json.avisos.nombre, 'Debe coincidir exactamente con tu Constancia de Situación Fiscal.');
});

await t('3. RFC de persona moral válido (12) se acepta', async () => {
  const r = await validar(liga.token, MORAL);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.datos.tipo_persona, 'moral');
  assert.equal(r.json.datos.rfc, MORAL.rfc);
});

await t('4. RFC de persona física válido (13) se acepta', async () => {
  const r = await validar(liga.token, FISICA);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.datos.tipo_persona, 'fisica');
});

await t('5. RFC inválido se rechaza con error por campo', async () => {
  for (const malo of ['HOLA', 'ABC01010AB1', 'ABCD0101011234', '123456789012', '']) {
    const r = await validar(liga.token, { ...MORAL, rfc: malo });
    assert.equal(r.status, 422, `RFC "${malo}" no fue rechazado`);
    assert.ok(r.json.errores.rfc, 'sin mensaje para rfc');
    assert.ok(!r.json.errores.nombre, 'solo el RFC estaba mal');
  }
});

await t('6. RFC genérico se rechaza con el mensaje acordado', async () => {
  for (const generico of ['XAXX010101000', 'xaxx-010101-000', 'XEXX010101000']) {
    const r = await validar(liga.token, { ...FISICA, rfc: generico, regimen: '616', uso_cfdi: 'S01' });
    assert.equal(r.status, 422);
    assert.equal(r.json.errores.rfc, 'La autofacturación nominativa no admite RFC genérico por el momento.');
  }
});

await t('7. el nombre / razón social es obligatorio y no se corrige', async () => {
  for (const malo of ['', '   ', 'AB', 'x'.repeat(300)]) {
    const r = await validar(liga.token, { ...MORAL, nombre: malo });
    assert.equal(r.status, 422); assert.ok(r.json.errores.nombre);
  }
  const r = await validar(liga.token, { ...MORAL, nombre: '  Empresa de Prueba SA de CV  ' });
  assert.equal(r.status, 200);
  assert.equal(r.json.datos.nombre, 'Empresa de Prueba SA de CV', 'solo se recorta: no se pone en mayúsculas ni se quita el "SA de CV"');
});

await t('8. el CP fiscal debe tener exactamente 5 dígitos', async () => {
  for (const malo of ['2600', '260000', '26 000', 'ABCDE', '', '26000a']) {
    const r = await validar(liga.token, { ...MORAL, cp: malo });
    assert.equal(r.status, 422, `CP "${malo}" no fue rechazado`); assert.ok(r.json.errores.cp);
  }
  assert.equal((await validar(liga.token, { ...MORAL, cp: ' 26000 ' })).status, 200);
});

await t('9. un régimen fuera del catálogo (o que no aplica a la persona) se rechaza', async () => {
  for (const malo of ['999', 'abc', '', "601' OR 1=1"]) {
    const r = await validar(liga.token, { ...MORAL, regimen: malo });
    assert.equal(r.status, 422, `régimen "${malo}" no fue rechazado`); assert.ok(r.json.errores.regimen);
  }
  const fisicaConMoral = await validar(liga.token, { ...FISICA, regimen: '601' });
  assert.equal(fisicaConMoral.status, 422); assert.match(fisicaConMoral.json.errores.regimen, /no aplica a personas físicas/);
  const moralConFisica = await validar(liga.token, { ...MORAL, regimen: '612' });
  assert.equal(moralConFisica.status, 422); assert.match(moralConFisica.json.errores.regimen, /no aplica a personas morales/);
});

await t('10. un uso de CFDI fuera del catálogo (o que no aplica a la persona) se rechaza', async () => {
  for (const malo of ['Z99', 'gastos', '', 'G0']) {
    const r = await validar(liga.token, { ...MORAL, uso_cfdi: malo });
    assert.equal(r.status, 422, `uso "${malo}" no fue rechazado`); assert.ok(r.json.errores.uso_cfdi);
  }
  const moralConD01 = await validar(liga.token, { ...MORAL, uso_cfdi: 'D01' });
  assert.equal(moralConD01.status, 422); assert.match(moralConD01.json.errores.uso_cfdi, /no aplica a personas morales/);
  assert.equal((await validar(liga.token, { ...MORAL, uso_cfdi: 'g03' })).status, 200, 'la clave se normaliza a mayúsculas');
});

await t('10b. régimen y uso existentes pero incompatibles según el SAT se rechazan; compatibles pasan', async () => {
  // Compatibles (columna "Régimen Fiscal Receptor" de c_UsoCFDI).
  for (const ok of [
    { ...MORAL, regimen: '601', uso_cfdi: 'G03' }, { ...MORAL, regimen: '601', uso_cfdi: 'G01' },
    { ...FISICA, regimen: '605', uso_cfdi: 'G03' }, { ...FISICA, regimen: '605', uso_cfdi: 'D01' },
    { ...FISICA, regimen: '616', uso_cfdi: 'S01' }, { ...FISICA, regimen: '626', uso_cfdi: 'G03' },
  ]) {
    const r = await validar(liga.token, ok);
    assert.equal(r.status, 200, `${ok.regimen}+${ok.uso_cfdi} debía ser compatible: ${r.texto}`);
  }
  // Existentes pero incompatibles.
  for (const malo of [
    { ...FISICA, regimen: '616', uso_cfdi: 'G03' }, // Sin obligaciones fiscales no admite Gastos en general
    { ...FISICA, regimen: '605', uso_cfdi: 'G01' }, // Sueldos y salarios no admite Adquisición de mercancías
    { ...MORAL, regimen: '601', uso_cfdi: 'CN01' }, // (CN01 tampoco aplica a morales; el mensaje de persona gana)
    { ...FISICA, regimen: '612', uso_cfdi: 'CN01' }, // Nómina solo para 605
  ]) {
    const r = await validar(liga.token, malo);
    assert.equal(r.status, 422, `${malo.regimen}+${malo.uso_cfdi} debía rechazarse`);
    assert.ok(r.json.errores.uso_cfdi, 'el error va en uso_cfdi');
    assert.ok(!r.json.errores.regimen, 'el régimen en sí es válido');
  }
  const r = await validar(liga.token, { ...FISICA, regimen: '616', uso_cfdi: 'G03' });
  assert.equal(r.json.errores.uso_cfdi, 'Este uso de CFDI no es compatible con el régimen fiscal seleccionado.');
});

await t('11. correo inválido o ausente se rechaza', async () => {
  for (const malo of ['', 'sin-arroba', 'a@b', 'a b@c.com', 'x'.repeat(250) + '@c.com']) {
    const r = await validar(liga.token, { ...MORAL, email: malo });
    assert.equal(r.status, 422, `email "${malo.slice(0, 20)}" no fue rechazado`); assert.ok(r.json.errores.email);
  }
});

await t('12. los datos válidos vuelven normalizados con las etiquetas del backend', async () => {
  const r = await validar(liga.token, { rfc: ' abc-010101-ab1 ', nombre: '  Empresa de Prueba SA de CV ', cp: '26000', regimen: ' 601 ', uso_cfdi: 'g03', email: '  Facturas@Empresa-Prueba.TEST ' });
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.json.datos, {
    rfc: 'ABC010101AB1', tipo_persona: 'moral', nombre: 'Empresa de Prueba SA de CV', cp: '26000',
    regimen: '601', regimen_nombre: 'General de Ley Personas Morales',
    uso_cfdi: 'G03', uso_nombre: 'Gastos en general', email: 'facturas@empresa-prueba.test',
  });
  assert.deepEqual(r.json.venta, { folio: F('OK'), total: 150 });
  assert.deepEqual(Object.keys(r.json).sort(), ['datos', 'ok', 'venta']);
});

await t('13. validar NO persiste datos fiscales ni toca la autofactura', async () => {
  const antes = await filaAf(NEG, F('OK'));
  await validar(liga.token, MORAL); await validar(liga.token, FISICA);
  const { rows: fichas } = await pool.query('SELECT 1 FROM clientes_fiscales WHERE negocio_id=$1 AND rfc = ANY($2)', [NEG, [MORAL.rfc, FISICA.rfc]]);
  assert.equal(fichas.length, 0, 'se guardó una ficha fiscal');
  assert.deepEqual(await filaAf(NEG, F('OK')), antes, 'la fila de autofactura cambió');
  const { rows: cols } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='autofacturas' AND column_name IN ('rfc','razon_social','email','cp')`);
  assert.equal(cols.length, 0, 'autofacturas no tiene columnas fiscales en esta fase');
});

await t('14. token inexistente o malformado → 404 genérico también en validar', async () => {
  const inventado = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64url');
  for (const tk of [inventado, 'XAB-0001', encodeURIComponent("' OR 1=1 --")]) {
    const r = await validar(tk, MORAL);
    assert.equal(r.status, 404); assert.deepEqual(r.json, { error: 'No encontramos esta liga de facturación.' });
  }
});

await t('15. liga expirada no puede validar', async () => {
  const l = await ligaNueva(NEG, 'EXP');
  await pool.query(`UPDATE autofacturas SET expires_at = now() - interval '1 day' WHERE negocio_id=$1 AND folio=$2`, [NEG, F('EXP')]);
  const r = await validar(l.token, MORAL);
  assert.equal(r.status, 409); assert.equal(r.json.estado, 'expirada'); assert.equal(r.json.error, 'Esta liga de facturación ha expirado.');
});

await t('16. liga revocada no puede validar', async () => {
  const l = await ligaNueva(NEG, 'REV');
  await revocarAutofactura(NEG, F('REV'));
  const r = await validar(l.token, MORAL);
  assert.equal(r.status, 409); assert.equal(r.json.estado, 'revocada');
});

await t('17. liga facturada no puede validar', async () => {
  const l = await ligaNueva(NEG, 'FAC');
  await pool.query(`UPDATE autofacturas SET estado='facturada', factura_id='inv_form_prueba', uuid='33333333-4444-5555-6666-777777777777', emitida_at=now(), fuente_emision='portal' WHERE negocio_id=$1 AND folio=$2`, [NEG, F('FAC')]);
  const r = await validar(l.token, MORAL);
  assert.equal(r.status, 409); assert.equal(r.json.estado, 'facturada'); assert.equal(r.json.error, 'Este consumo ya fue facturado.');
  assert.ok(!r.texto.includes('inv_form_prueba') && !r.texto.includes('33333333'));
});

await t('18. negocio inactivo no valida', async () => {
  const l = await ligaNueva(NEG_B, 'INACT');
  await pool.query('UPDATE negocios SET activo=FALSE WHERE id=$1', [NEG_B]);
  try { const r = await validar(l.token, MORAL); assert.equal(r.status, 404); }
  finally { await pool.query('UPDATE negocios SET activo=TRUE WHERE id=$1', [NEG_B]); }
});

await t('19. módulo de facturación apagado no valida', async () => {
  const l = await ligaNueva(NEG_B, 'MOD');
  await fijarModulo(NEG_B, 'suspendido');
  try { const r = await validar(l.token, MORAL); assert.equal(r.status, 404); }
  finally { await fijarModulo(NEG_B, 'activo'); }
  assert.equal((await validar(l.token, MORAL)).status, 200, 'con el módulo activo vuelve a validar');
});

await t('20. si el total de la venta cambió, validar responde TOTAL_CAMBIO', async () => {
  const l = await ligaNueva(NEG, 'TOTAL');
  await pool.query(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{total}', '199') WHERE folio=$1`, [F('TOTAL')]);
  const r = await validar(l.token, MORAL);
  assert.equal(r.status, 409); assert.equal(r.json.codigo, 'TOTAL_CAMBIO');
  await pool.query(`UPDATE pedidos_activos SET estado='cancelado' WHERE folio=$1`, [F('TOTAL')]);
  const c = await validar(l.token, MORAL);
  assert.equal(c.status, 409); assert.equal(c.json.codigo, 'VENTA_NO_FACTURABLE');
});

await t('21. ninguna respuesta filtra token, hash, cifrado, negocio_id ni errores internos', async () => {
  const db = await filaAf(NEG, F('OK'));
  const respuestas = [
    (await get(liga.token)).texto, (await validar(liga.token, MORAL)).texto, (await validar(liga.token, { rfc: 'x' })).texto,
  ];
  for (const texto of respuestas) {
    for (const v of [liga.token, db.token_hash, db.token_cifrado, db.token_iv, db.token_auth_tag, NEG, db.id]) {
      assert.ok(!texto.includes(v), 'un dato interno viajó al navegador');
    }
    assert.ok(!/negocio_?id|token_hash|cifrad|auth_tag|intento_key|error_detalle|stack|pg_|syntax/i.test(texto));
  }
});

await t('21b. límite real del cuerpo: JSON normal OK, >8 KB con Content-Length → 413, chunked >8 KB sin Content-Length → 413, JSON inválido → 400', async () => {
  assert.equal((await validar(liga.token, MORAL)).status, 200, 'un JSON normal sigue funcionando');
  const malformado = await validar(liga.token, '{"rfc": ');
  assert.equal(malformado.status, 400); assert.deepEqual(malformado.json, { error: 'Cuerpo inválido.' });
  const arreglo = await validar(liga.token, '[1,2,3]');
  assert.equal(arreglo.status, 400);
  const grande = await validar(liga.token, { ...MORAL, nombre: 'x'.repeat(20000) });
  assert.equal(grande.status, 413, 'Content-Length > 8 KB');
  assert.deepEqual(grande.json, { error: 'Los datos enviados son demasiado grandes.' });

  // Chunked sin Content-Length: el parser debe cortar la lectura al pasar de 8 KB.
  const http = await import('node:http');
  const u = new URL(`${base}/api/autofactura/${liga.token}/validar`);
  const cuerpo = JSON.stringify({ ...MORAL, nombre: 'y'.repeat(40000) });
  const resultado = await new Promise((resolve) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', (e) => resolve({ status: null, error: e.message }));
    for (let i = 0; i < cuerpo.length; i += 1024) req.write(cuerpo.slice(i, i + 1024));
    req.end();
  });
  assert.equal(resultado.status, 413, `chunked > 8 KB debía dar 413: ${JSON.stringify(resultado)}`);
  assert.deepEqual(JSON.parse(resultado.data), { error: 'Los datos enviados son demasiado grandes.' });
  // Y un chunked pequeño sí se acepta: el límite es por tamaño, no por transferencia.
  const chico = JSON.stringify(MORAL);
  const ok = await new Promise((resolve) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    }, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, data })); });
    req.on('error', (e) => resolve({ status: null, error: e.message }));
    req.write(chico.slice(0, 20)); req.write(chico.slice(20)); req.end();
  });
  assert.equal(ok.status, 200, `chunked pequeño: ${JSON.stringify(ok)}`);
});

await t('22. E2E navegador: llenar el formulario y llegar a "Confirma tus datos"', async () => {
  const page = await browser.newPage(); page.setDefaultTimeout(15000);
  await page.setRequestInterception(true);
  page.on('request', (req) => (req.url().startsWith(base) ? req.continue() : req.abort()));
  await page.goto(`${base}/f/${liga.token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#af-rfc');
  // Primero un intento inválido: el error aparece bajo el campo, sin salir del formulario.
  await page.click('#af-continuar');
  await page.waitForFunction(() => document.querySelector('#af-err-rfc') && document.querySelector('#af-err-rfc').textContent.length > 0);
  await page.type('#af-rfc', MORAL.rfc);
  await page.type('#af-nombre', MORAL.nombre);
  await page.type('#af-cp', MORAL.cp);
  await page.select('#af-regimen', MORAL.regimen);
  await page.select('#af-uso_cfdi', MORAL.uso_cfdi);
  await page.type('#af-email', MORAL.email);
  await page.click('#af-continuar');
  await page.waitForFunction(() => document.getElementById("app").textContent.includes('Confirma tus datos'));
  const texto = await page.evaluate(() => document.getElementById("app").textContent.replace(/\s+/g, ' '));
  for (const v of [MORAL.rfc, MORAL.nombre, MORAL.cp, '601 – General de Ley Personas Morales', 'G03 – Gastos en general', MORAL.email, F('OK'), '$150.00']) {
    assert.ok(texto.includes(v), `la confirmación no muestra "${v}" -- texto: ${texto.slice(0, 700)}`);
  }
  globalThis.__pagina = page;
});

await t('23. Corregir vuelve al formulario con los valores conservados', async () => {
  const page = globalThis.__pagina;
  await page.click('#af-corregir');
  await page.waitForSelector('#af-rfc');
  const valores = await page.evaluate(() => ({
    rfc: document.querySelector('#af-rfc').value, nombre: document.querySelector('#af-nombre').value,
    cp: document.querySelector('#af-cp').value, regimen: document.querySelector('#af-regimen').value,
    uso: document.querySelector('#af-uso_cfdi').value, email: document.querySelector('#af-email').value,
  }));
  assert.deepEqual(valores, { rfc: MORAL.rfc, nombre: MORAL.nombre, cp: MORAL.cp, regimen: MORAL.regimen, uso: MORAL.uso_cfdi, email: MORAL.email });
  await page.click('#af-continuar');
  await page.waitForFunction(() => document.getElementById("app").textContent.includes('Confirma tus datos'));
});

await t('24. "Confirmar datos" en esta fase no llama Facturapi ni cambia el estado de la liga', async () => {
  const page = globalThis.__pagina;
  const antes = await filaAf(NEG, F('OK'));
  const salidaAntes = srv.obtenerSalida().length;
  await page.click('#af-confirmar');
  await page.waitForFunction(() => document.getElementById("app").textContent.includes('Datos validados correctamente. La emisión de factura se habilitará en el siguiente paso.'));
  await new Promise((r) => setTimeout(r, 400));
  const despues = await filaAf(NEG, F('OK'));
  assert.deepEqual(despues, antes, 'la fila de autofactura cambió al confirmar');
  assert.equal(despues.estado, 'vigente');
  assert.equal((await pool.query('SELECT 1 FROM facturas_pedido WHERE negocio_id=$1 AND folio=$2', [NEG, F('OK')])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2', [NEG, F('OK')])).rowCount, 0);
  const salidaNueva = srv.obtenerSalida().slice(salidaAntes);
  assert.ok(!/facturapi\.io|\[Facturacion\]|invoices/i.test(salidaNueva), 'el servidor intentó algo con Facturapi');
  await page.close();
});

await t('25. E2E: cambiar el régimen actualiza los usos de CFDI disponibles', async () => {
  const page = await browser.newPage(); page.setDefaultTimeout(15000);
  await page.setRequestInterception(true);
  page.on('request', (req) => (req.url().startsWith(base) ? req.continue() : req.abort()));
  await page.goto(`${base}/f/${liga.token}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#af-rfc');
  const usos = () => page.$$eval('#af-uso_cfdi option', (ops) => ops.map((o) => o.value).filter(Boolean));
  await page.type('#af-rfc', FISICA.rfc);
  await page.select('#af-regimen', '616');
  let lista = await usos();
  assert.ok(lista.includes('S01') && lista.includes('CP01'), `616 debe ofrecer S01/CP01: ${lista}`);
  assert.ok(!lista.includes('G03') && !lista.includes('G01') && !lista.includes('D01'), `616 no debe ofrecer G03/G01/D01: ${lista}`);
  await page.select('#af-regimen', '605');
  lista = await usos();
  assert.ok(lista.includes('G03') && lista.includes('D01') && lista.includes('CN01'), `605 debe ofrecer G03/D01/CN01: ${lista}`);
  assert.ok(!lista.includes('G01'), `605 no debe ofrecer G01: ${lista}`);
  await page.select('#af-regimen', '612');
  lista = await usos();
  assert.ok(lista.includes('G01') && lista.includes('G03') && !lista.includes('CN01'), `612: ${lista}`);
  // Un uso elegido que deja de ser compatible al cambiar el régimen se limpia.
  await page.select('#af-uso_cfdi', 'G01');
  await page.select('#af-regimen', '605');
  assert.equal(await page.$eval('#af-uso_cfdi', (s) => s.value), '', 'G01 ya no aplica con 605: el select vuelve a vacío');
  await page.close();
});

} finally {
  if (browser) await browser.close().catch(() => {});
  srv.detener();
  await limpiar();
  for (const n of [NEG, NEG_B]) {
    const p = previo[n];
    await pool.query('UPDATE negocios SET activo=$2 WHERE id=$1', [n, p.activo]);
    if (p.modulo === null) await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [n]);
    else await fijarModulo(n, p.modulo);
    for (const clave of ['nombre', 'logo_url']) {
      if (clave in p.config) await pool.query('UPDATE configuracion SET valor=$3 WHERE negocio_id=$1 AND clave=$2', [n, clave, p.config[clave]]);
      else await pool.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [n, clave]);
    }
  }
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`PASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
