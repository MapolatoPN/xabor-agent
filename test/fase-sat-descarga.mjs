// Descarga masiva de CFDI RECIBIDOS del SAT, por negocio, contra un SIMULADOR
// SOAP local (nunca el SAT real).
//
// En producción la descarga no funcionaba:
//   - desde el 23-sep la e.firma de la base no se usaba (se pedía sin negocio,
//     el error se tragaba y se caía a variables de entorno inexistentes);
//   - antes, las solicitudes quedaban en «timeout» porque nadie las volvía a
//     verificar, la verificación ignoraba CodEstatus y la descarga usaba la
//     acción SOAP equivocada y leía el código en el lugar equivocado;
//   - el XML se guardaba en disco efímero y el parser tomaba el IVA del
//     concepto y agregaba una partida vacía.
// El simulador comprueba de verdad cada firma (digest SHA-1 del cuerpo y
// RSA-SHA1 de SignedInfo con el certificado enviado) y la acción SOAP.
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import forge from 'node-forge';
import AdmZip from 'adm-zip';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.notEqual(process.env.NODE_ENV, 'production', 'el simulador solo existe fuera de producción');
process.env.PANEL_SECRET = process.env.PANEL_SECRET || 'secreto-local-de-prueba-sat';

const { pool } = await import('../src/services/database.js');
const { guardarCredencialesSAT, eliminarCredencialesSAT } = await import('../src/services/satCredentials.js');
const { invalidarCacheCredenciales, parsearCFDI } = await import('../src/services/satClient.js');
const sat = await import('../src/services/satSync.js');
const { default: finanzasRouter } = await import('../src/routes/finanzas.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

// ═══ e.firma de prueba ═══
function generarEfirma(rfc) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const pki = forge.pki;
  const cert = pki.createCertificate();
  cert.publicKey = pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '30303030313030303030303630303030' + crypto.randomBytes(4).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  cert.setSubject([{ name: 'commonName', value: 'EMPRESA DE PRUEBA' }, { type: '2.5.4.45', value: `${rfc} / XIQB891116QE4` }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC DE PRUEBA' }]);
  cert.sign(pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  const der = forge.asn1.toDer(pki.certificateToAsn1(cert)).getBytes();
  return { certBase64: Buffer.from(der, 'binary').toString('base64'), privateKeyPem: privateKey };
}
const pemDe = (b64) => `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;

// ═══ CFDI 4.0 de ejemplo: impuestos por concepto Y del comprobante ═══
const cfdi = (uuid, rfcReceptor, total = '116.00', iva = '16.00') => `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="A" Folio="77" Fecha="2026-10-20T10:00:00" SubTotal="100.00" Total="${total}" Moneda="MXN" TipoDeComprobante="I" Exportacion="01" MetodoPago="PUE" FormaPago="03" LugarExpedicion="26000">
  <cfdi:Emisor Rfc="PRO010101AA1" Nombre="PROVEEDOR DE PRUEBA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${rfcReceptor}" Nombre="EMPRESA DE PRUEBA" DomicilioFiscalReceptor="26000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="50202306" Cantidad="2" ClaveUnidad="H87" Unidad="Pieza con una unidad de medida larga" Descripcion="Refresco" ValorUnitario="50.00" Importe="100.00" ObjetoImp="02">
      <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${iva}"/></cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="${iva}"><cfdi:Traslados><cfdi:Traslado Base="100.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${iva}"/></cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${uuid}" FechaTimbrado="2026-10-20T10:01:00"/></cfdi:Complemento>
</cfdi:Comprobante>`;
function zipCon(archivos) {
  const z = new AdmZip();
  for (const [nombre, xml] of Object.entries(archivos)) z.addFile(nombre, Buffer.from(xml, 'utf8'));
  return z.toBuffer().toString('base64');
}

// ═══ Simulador SOAP ═══
const ACC = {
  auth: '"http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica"',
  sol: '"http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/SolicitaDescargaRecibidos"',
  ver: '"http://DescargaMasivaTerceros.sat.gob.mx/IVerificaSolicitudDescargaService/VerificaSolicitudDescarga"',
  des: '"http://DescargaMasivaTerceros.sat.gob.mx/IDescargaMasivaTercerosService/Descargar"',
};
const sim = { llamadas: [], solicitudes: [], respuestaSolicitud: [], verificaciones: {}, paquetes: {}, descargaFalla: [], certs: [], n: 0 };
function revisarFirma(body, raiz, hijo) {
  const attrs = (body.match(new RegExp(`<${hijo} ([^>]*)>`)) || [])[1];
  if (!attrs) return 'sin atributos';
  const toDigest = `<${raiz} xmlns:des="http://DescargaMasivaTerceros.sat.gob.mx"><${hijo} ${attrs}></${hijo}></${raiz}>`;
  const digest = crypto.createHash('sha1').update(toDigest).digest('base64');
  if (digest !== (body.match(/<DigestValue>([^<]+)<\/DigestValue>/) || [])[1]) return 'digest';
  const signedInfo = (body.match(/<SignedInfo>[\s\S]*?<\/SignedInfo>/) || [''])[0]
    .replace('<SignedInfo>', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">');
  const firma = (body.match(/<SignatureValue>([^<]+)<\/SignatureValue>/) || [])[1];
  const certB64 = (body.match(/<X509Certificate>([^<]+)<\/X509Certificate>/) || [])[1];
  if (!firma || !certB64) return 'sin firma';
  sim.certs.push(certB64);
  const ok = crypto.createVerify('SHA1').update(signedInfo).verify(new crypto.X509Certificate(pemDe(certB64)).publicKey, firma, 'base64');
  return ok ? null : 'firma RSA';
}
const atributo = (body, a) => (body.match(new RegExp(`\\s${a}="([^"]*)"`)) || [])[1];
const envelope = (cuerpo, encabezado = '') => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header>${encabezado}</s:Header><s:Body>${cuerpo}</s:Body></s:Envelope>`;
const servidor = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const accion = req.headers.soapaction;
    const responder = (status, xml) => { res.writeHead(status, { 'Content-Type': 'text/xml' }); res.end(xml); };
    sim.llamadas.push(`${req.url} ${accion}`);
    if (req.url.endsWith('/Autenticacion.svc')) {
      if (accion !== ACC.auth) return responder(400, 'acción');
      return responder(200, envelope('<AutenticaResponse xmlns="http://DescargaMasivaTerceros.gob.mx"><AutenticaResult>TOKEN-SIM</AutenticaResult></AutenticaResponse>'));
    }
    if (req.headers.authorization !== 'WRAP access_token="TOKEN-SIM"') return responder(401, 'token');
    if (req.url.endsWith('/SolicitaDescargaService.svc')) {
      const err = accion !== ACC.sol ? 'acción' : revisarFirma(body, 'des:SolicitaDescargaRecibidos', 'des:solicitud');
      if (err) return responder(400, `rechazo simulador: ${err}`);
      const r = sim.respuestaSolicitud.shift() || { cod: '5000' };
      const id = `SOL-${++sim.n}`;
      sim.solicitudes.push({ id, fi: atributo(body, 'FechaInicial'), ff: atributo(body, 'FechaFinal'), rfc: atributo(body, 'RfcSolicitante'), cod: r.cod });
      return responder(200, envelope(`<SolicitaDescargaRecibidosResponse xmlns="http://DescargaMasivaTerceros.sat.gob.mx"><SolicitaDescargaRecibidosResult${r.cod === '5000' ? ` IdSolicitud="${id}"` : ''} CodEstatus="${r.cod}" Mensaje="${r.cod === '5000' ? 'Solicitud Aceptada' : 'Rechazo ' + r.cod}"/></SolicitaDescargaRecibidosResponse>`));
    }
    if (req.url.endsWith('/VerificaSolicitudDescargaService.svc')) {
      const err = accion !== ACC.ver ? 'acción' : revisarFirma(body, 'des:VerificaSolicitudDescarga', 'des:solicitud');
      if (err) return responder(400, `rechazo simulador: ${err}`);
      const id = atributo(body, 'IdSolicitud');
      const r = (sim.verificaciones[id] || []).shift() || { estado: '2' };
      if (r.http) return responder(r.http, 'caído');
      const pk = (r.paquetes || []).map((p) => `<IdsPaquetes>${p}</IdsPaquetes>`).join('');
      return responder(200, envelope(`<VerificaSolicitudDescargaResponse xmlns="http://DescargaMasivaTerceros.sat.gob.mx"><VerificaSolicitudDescargaResult CodEstatus="${r.cod || '5000'}" EstadoSolicitud="${r.estado}" CodigoEstadoSolicitud="${r.codEstado || '5000'}" NumeroCFDIs="${r.num || 0}" Mensaje="${r.mensaje || 'Solicitud Aceptada'}">${pk}</VerificaSolicitudDescargaResult></VerificaSolicitudDescargaResponse>`));
    }
    if (req.url.endsWith('/DescargaMasivaService.svc')) {
      const err = accion !== ACC.des ? 'acción' : revisarFirma(body, 'des:PeticionDescargaMasivaTercerosEntrada', 'des:peticionDescarga');
      if (err) return responder(400, `rechazo simulador: ${err}`);
      const id = atributo(body, 'IdPaquete');
      const falla = sim.descargaFalla.shift();
      const cod = falla || '5000';
      return responder(200, envelope(
        `<RespuestaDescargaMasivaTercerosSalida xmlns="http://DescargaMasivaTerceros.sat.gob.mx">${cod === '5000' ? `<Paquete>${sim.paquetes[id]}</Paquete>` : ''}</RespuestaDescargaMasivaTercerosSalida>`,
        `<h:respuesta CodEstatus="${cod}" Mensaje="${cod === '5000' ? 'Solicitud Aceptada' : 'Paquete no disponible'}" xmlns:h="http://DescargaMasivaTerceros.sat.gob.mx" xmlns="http://DescargaMasivaTerceros.sat.gob.mx"/>`));
    }
    responder(404, 'no');
  });
});
await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
process.env.SAT_SIMULADOR_URL = `http://127.0.0.1:${servidor.address().port}`;

// ═══ Datos ═══
const { rows: negocios } = await pool.query('SELECT id::text AS id FROM negocios ORDER BY created_at LIMIT 2');
const [NEG, NEG_B] = negocios.map((n) => n.id);
const RFC_A = 'EKU9003173C9', RFC_B = 'IIA040805DZ4';
const EF_A = generarEfirma(RFC_A), EF_B = generarEfirma(RFC_B);
const ANTES = { cert: (await pool.query(`SELECT negocio_id::text n FROM configuracion WHERE clave='sat_cert_base64_db'`)).rows.map((r) => r.n) };
assert.deepEqual(ANTES.cert, [], 'la base de prueba ya traía e.firmas: la prueba de la migración no aplicaría');
const limpiar = async () => {
  for (const n of [NEG, NEG_B, 'default']) {
    await pool.query(`DELETE FROM sat_packages WHERE download_request_id IN (SELECT id FROM sat_download_requests WHERE negocio_id=$1)`, [n]);
    await pool.query(`DELETE FROM sat_download_requests WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE negocio_id=$1)`, [n]);
    await pool.query(`DELETE FROM invoices WHERE negocio_id=$1`, [n]);
    await pool.query(`DELETE FROM sat_accounts WHERE negocio_id=$1`, [n]);
  }
  for (const n of [NEG, NEG_B]) await eliminarCredencialesSAT(n).catch(() => {});
  invalidarCacheCredenciales();
};
const solicitudes = (n) => pool.query(`SELECT * FROM sat_download_requests WHERE negocio_id=$1 ORDER BY id`, [n]).then((r) => r.rows);
const A_LAS_3 = new Date('2026-10-21T08:00:00Z');      // 03:00 en Matamoros (horario de verano)

await limpiar();
try {
  await guardarCredencialesSAT(NEG, { certBase64: EF_A.certBase64, privateKeyPem: EF_A.privateKeyPem, certInfo: { rfc: RFC_A, serial: '1' } });
  invalidarCacheCredenciales();

  await t('M. la migración 120 pasa lo de «default» al único negocio con e.firma', async () => {
    await pool.query(`INSERT INTO sat_accounts (negocio_id, rfc, active) VALUES ('default', $1, TRUE)`, [RFC_A]);
    await pool.query(`INSERT INTO sat_download_requests (negocio_id, fecha_inicial, fecha_final, download_type, status, requested_at, sat_request_id)
                      VALUES ('default','2026-09-01T00:00:00','2026-09-01T23:59:59','recibidos','timeout', NOW() - INTERVAL '30 days', 'VIEJA-1')`);
    await pool.query(readFileSync(new URL('../migrations/120_sat_descarga_por_negocio.sql', import.meta.url), 'utf8'));
    const { rows: [c] } = await pool.query(`SELECT count(*)::int n FROM sat_download_requests WHERE negocio_id='default'`);
    assert.equal(c.n, 0);
    assert.equal((await solicitudes(NEG)).length, 1);
    const { rows: [cta] } = await pool.query(`SELECT negocio_id FROM sat_accounts WHERE rfc=$1`, [RFC_A]);
    assert.equal(cta.negocio_id, NEG);
  });

  await t('1. sin e.firma el negocio no llama al SAT: EFIRMA_NO_CONFIGURADA', async () => {
    const i = sim.llamadas.length;
    await assert.rejects(() => sat.sincronizarNegocio(NEG_B, { ahora: A_LAS_3 }), (e) => e.codigo === 'EFIRMA_NO_CONFIGURADA');
    assert.equal(sim.llamadas.length, i);
  });

  await t('2. la solicitud vieja de más de 72 h se marca vencida sin consultar al SAT', async () => {
    const i = sim.llamadas.length;
    await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3, pedirAyer: false });
    const vieja = (await solicitudes(NEG)).find((s) => s.sat_request_id === 'VIEJA-1');
    assert.equal(vieja.status, 'vencida');
    assert.ok(!sim.llamadas.slice(i).some((l) => l.includes('Verifica')), 'consultó una solicitud vencida');
  });

  await t('3. a las 03:00 pide el día anterior completo, firmado con la e.firma de SU negocio, una sola vez', async () => {
    sim.certs.length = 0;
    await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3 });
    await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3 });
    const pedidas = sim.solicitudes.filter((s) => s.rfc === RFC_A);
    assert.equal(pedidas.length, 1, 'pidió la misma ventana dos veces');
    assert.deepEqual([pedidas[0].fi, pedidas[0].ff], ['2026-10-20T00:00:00', '2026-10-20T23:59:59']);
    assert.ok(sim.certs.length && sim.certs.every((c) => c === EF_A.certBase64), 'firmó con otra e.firma');
    const s = (await solicitudes(NEG)).find((x) => x.sat_request_id === pedidas[0].id);
    assert.equal(s.status, 'pendiente_sat'); assert.equal(s.cod_estatus, '5000');
  });

  await t('4. en proceso (EstadoSolicitud 2): sigue pendiente y guarda el estado', async () => {
    const s = (await solicitudes(NEG)).find((x) => x.status === 'pendiente_sat');
    const r = await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3 });
    assert.ok(r.verificacion.pendientes >= 1);
    const d = (await solicitudes(NEG)).find((x) => x.id === s.id);
    assert.equal(d.status, 'pendiente_sat'); assert.equal(d.estado_solicitud, '2');
  });

  await t('5. terminada: descarga con la acción «Descargar», guarda los CFDI con su XML en la base, IVA del comprobante y sin partida vacía', async () => {
    const s = (await solicitudes(NEG)).find((x) => x.status === 'pendiente_sat');
    const u1 = crypto.randomUUID().toUpperCase(), u2 = crypto.randomUUID().toUpperCase();
    sim.paquetes['PKG-A1'] = zipCon({ [`${u1}.xml`]: cfdi(u1, RFC_A), [`${u2}.xml`]: cfdi(u2, RFC_A, '232.00', '32.00') });
    sim.verificaciones[s.sat_request_id] = [{ estado: '3', num: 2, paquetes: ['PKG-A1'] }];
    const i = sim.llamadas.length;
    await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3 });
    assert.ok(sim.llamadas.slice(i).some((l) => l.endsWith(ACC.des)), sim.llamadas.slice(i).join(' | '));
    assert.equal((await solicitudes(NEG)).find((x) => x.id === s.id).status, 'completado');
    const { rows } = await pool.query(`SELECT id, uuid, impuestos_trasladados, xml IS NOT NULL con_xml FROM invoices WHERE negocio_id=$1 ORDER BY total`, [NEG]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => Number(r.impuestos_trasladados)), [16, 32]);
    assert.ok(rows.every((r) => r.con_xml));
    const { rows: items } = await pool.query(`SELECT invoice_id, unidad FROM invoice_items WHERE invoice_id = ANY($1)`, [rows.map((r) => r.id)]);
    assert.equal(items.length, 2, 'una partida por factura');
    assert.ok(items.every((x) => x.unidad === 'Pieza con una unidad de medida larga'));
  });

  await t('6. el XML sale de la base y cada negocio solo ve lo suyo', async () => {
    const { facturas } = await sat.listarFacturas(NEG);
    const xml = await sat.obtenerXmlFactura(NEG, facturas[0].id);
    assert.match(xml, /TimbreFiscalDigital/);
    assert.equal(await sat.obtenerXmlFactura(NEG_B, facturas[0].id), null);
    assert.equal((await sat.listarFacturas(NEG_B)).total, 0);
  });

  await t('7. parser: el IVA del comprobante, no el del concepto; una partida', async () => {
    const c = parsearCFDI(cfdi('UUID-X', RFC_A, '116.00', '16.00').replace('TotalImpuestosTrasladados="16.00"', 'TotalImpuestosTrasladados="16.00" TotalImpuestosRetenidos="1.00"'));
    assert.equal(c.impuestos_trasladados, 16); assert.equal(c.impuestos_retenidos, 1); assert.equal(c.items.length, 1);
  });

  await t('8. el SAT rechaza la solicitud: 5002 agotada, 5005 duplicada, 5004 sin datos; ninguna se vuelve a pedir', async () => {
    const casos = [['5002', 'agotada', '2026-10-01'], ['5005', 'duplicada', '2026-10-02'], ['5004', 'sin_datos', '2026-10-03']];
    for (const [cod, estado, dia] of casos) {
      sim.respuestaSolicitud.push({ cod });
      await sat.sincronizarRango(NEG, `${dia}T00:00:00`, `${dia}T23:59:59`).catch(() => {});
      const s = (await solicitudes(NEG)).find((x) => x.fecha_inicial && String(x.fecha_inicial).length && x.cod_estatus === cod);
      assert.equal(s?.status, estado, `${cod} → ${s?.status}`);
      assert.ok(s.mensaje, 'guardó el mensaje del SAT');
      const antes = sim.solicitudes.length;
      await sat.sincronizarRango(NEG, `${dia}T00:00:00`, `${dia}T23:59:59`).catch(() => {});
      assert.equal(sim.solicitudes.length, antes, `volvió a pedir una ventana ${estado}`);
    }
  });

  await t('9. verificación con CodEstatus 300 (token o credencial): error con código y mensaje', async () => {
    sim.respuestaSolicitud.push({ cod: '5000' });
    await sat.sincronizarRango(NEG, '2026-10-05T00:00:00', '2026-10-05T23:59:59');
    const s = (await solicitudes(NEG)).find((x) => x.status === 'pendiente_sat');
    sim.verificaciones[s.sat_request_id] = [{ cod: '300', estado: '0', mensaje: 'Usuario No Válido' }];
    await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3, pedirAyer: false });
    const d = (await solicitudes(NEG)).find((x) => x.id === s.id);
    assert.equal(d.status, 'error'); assert.equal(d.error_code, '300'); assert.equal(d.mensaje, 'Usuario No Válido');
  });

  await t('10. falla de red al verificar: sigue viva, cuenta el intento con un error no vacío y el siguiente ciclo la termina', async () => {
    sim.respuestaSolicitud.push({ cod: '5000' });
    await sat.sincronizarRango(NEG, '2026-10-06T00:00:00', '2026-10-06T23:59:59');
    const s = (await solicitudes(NEG)).find((x) => x.status === 'pendiente_sat');
    sim.verificaciones[s.sat_request_id] = [{ http: 500 }, { estado: '3', paquetes: [] }];
    await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3, pedirAyer: false });
    let d = (await solicitudes(NEG)).find((x) => x.id === s.id);
    assert.equal(d.status, 'pendiente_sat'); assert.equal(d.intentos, 1); assert.ok(d.error_message && d.error_code, JSON.stringify(d));
    await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3, pedirAyer: false });
    d = (await solicitudes(NEG)).find((x) => x.id === s.id);
    assert.equal(d.status, 'sin_datos');
  });

  await t('11. descarga rechazada en el encabezado: el paquete queda en error, la solicitud verificada, y el siguiente ciclo la completa', async () => {
    sim.respuestaSolicitud.push({ cod: '5000' });
    await sat.sincronizarRango(NEG, '2026-10-07T00:00:00', '2026-10-07T23:59:59');
    const s = (await solicitudes(NEG)).find((x) => x.status === 'pendiente_sat');
    const u = crypto.randomUUID().toUpperCase();
    sim.paquetes['PKG-A2'] = zipCon({ [`${u}.xml`]: cfdi(u, RFC_A, '348.00', '48.00') });
    sim.verificaciones[s.sat_request_id] = [{ estado: '3', paquetes: ['PKG-A2'] }, { estado: '3', paquetes: ['PKG-A2'] }];
    sim.descargaFalla.push('5007');
    await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3, pedirAyer: false });
    let d = (await solicitudes(NEG)).find((x) => x.id === s.id);
    assert.equal(d.status, 'verificado'); assert.equal(d.error_code, '5007');
    await sat.sincronizarNegocio(NEG, { ahora: A_LAS_3, pedirAyer: false });
    d = (await solicitudes(NEG)).find((x) => x.id === s.id);
    assert.equal(d.status, 'completado');
    assert.equal((await pool.query(`SELECT 1 FROM invoices WHERE negocio_id=$1 AND uuid=$2`, [NEG, u])).rowCount, 1);
  });

  await t('12. dos negocios con e.firma: el tick firma cada uno con la suya y no mezcla datos', async () => {
    await guardarCredencialesSAT(NEG_B, { certBase64: EF_B.certBase64, privateKeyPem: EF_B.privateKeyPem, certInfo: { rfc: RFC_B, serial: '2' } });
    invalidarCacheCredenciales(NEG_B);
    sim.certs.length = 0;
    const r = await sat.tickSAT({ ahora: A_LAS_3 });
    assert.ok(!r[NEG_B]?.error && !r[NEG]?.error, JSON.stringify(r));
    const deB = sim.solicitudes.filter((s) => s.rfc === RFC_B);
    assert.equal(deB.length, 1);
    // A ya tiene su ventana de ayer completada: en este ciclo solo B firma.
    assert.ok(sim.certs.length > 0 && sim.certs.every((c) => c === EF_B.certBase64), 'B firmó con otra e.firma');
    assert.equal((await solicitudes(NEG_B)).length, 1);
  });

  await t('13. /api/finanzas: lo del negocio de la sesión, y server.js lo monta con sesión de admin y el módulo de facturación', async () => {
    const app = express(); app.use(express.json());
    app.use('/api/finanzas', (req, res, next) => { req.negocioId = req.get('x-negocio'); next(); }, finanzasRouter);
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    try {
      const base = `http://127.0.0.1:${s.address().port}`;
      const a = await (await fetch(`${base}/api/finanzas/facturas`, { headers: { 'x-negocio': NEG } })).json();
      const b = await (await fetch(`${base}/api/finanzas/facturas`, { headers: { 'x-negocio': NEG_B } })).json();
      assert.ok(a.total >= 3); assert.equal(b.total, 0);
      const v = await (await fetch(`${base}/api/finanzas/cuenta/validar`, { headers: { 'x-negocio': NEG_B } })).json();
      assert.equal(v.valido, true); assert.equal(v.rfc, RFC_B);
      const malo = await fetch(`${base}/api/finanzas/sync`, { method: 'POST', headers: { 'x-negocio': NEG, 'Content-Type': 'application/json' }, body: '{"fechaInicial":"ayer","fechaFinal":"hoy"}' });
      assert.equal(malo.status, 400);
    } finally { s.close(); }
    const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    assert.match(server, /app\.use\('\/api\/finanzas', requireAdminSeguro, requireModulo\('facturacion'\), finanzasRouter\)/);
    assert.ok(!/debug-cert|debug-network/.test(readFileSync(new URL('../src/routes/finanzas.js', import.meta.url), 'utf8')));
  });

  await t('14. en producción no hay respaldo a variables de entorno: sin e.firma en la base, falla claro', async () => {
    const { rows: [n3] } = await pool.query(`SELECT id::text id FROM negocios WHERE id::text <> ALL($1) ORDER BY created_at LIMIT 1`, [[NEG, NEG_B]]);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { validarCertificado } = await import('../src/services/satClient.js');
      await assert.rejects(() => validarCertificado(n3.id, RFC_A), (e) => e.codigo === 'EFIRMA_NO_CONFIGURADA');
    } finally { process.env.NODE_ENV = prev; }
  });
} finally {
  servidor.closeAllConnections?.();
  await new Promise((r) => servidor.close(() => r()));
  await limpiar();
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
