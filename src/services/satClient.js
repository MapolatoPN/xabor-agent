/**
 * satClient.js — Cliente para el Servicio Web de Descarga Masiva de CFDI del SAT
 *
 * SEGURIDAD:
 * - Las llaves privadas NUNCA se loguean ni se incluyen en código.
 * - La e.firma es POR NEGOCIO: se lee cifrada de la base (satCredentials.js).
 *   Solo fuera de producción se acepta el respaldo de desarrollo
 *   (SAT_CERT_BASE64 / SAT_KEY_BASE64 / SAT_KEY_PASSWORD o certs/RFC.*).
 * - La llave privada nunca sale de este módulo.
 *
 * Formato de las peticiones: phpcfdi/sat-ws-descarga-masiva (FielRequestBuilder).
 * Autenticación y solicitud no cambian respecto a lo que el SAT ya aceptó; la
 * verificación y la descarga se firman igual que la solicitud.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import crypto from 'crypto';
import { SAT_ENDPOINTS } from './sat-endpoints.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERTS_DIR = path.join(__dirname, '../../certs');
const NS_DES = 'http://DescargaMasivaTerceros.sat.gob.mx';
const ACCION = {
  autentica: '"http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica"',
  solicitaRecibidos: '"http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/SolicitaDescargaRecibidos"',
  verifica: '"http://DescargaMasivaTerceros.sat.gob.mx/IVerificaSolicitudDescargaService/VerificaSolicitudDescarga"',
  descarga: '"http://DescargaMasivaTerceros.sat.gob.mx/IDescargaMasivaTercerosService/Descargar"',
};

// Simulador SOAP de pruebas: solo fuera de producción.
function urls() {
  const base = process.env.NODE_ENV !== 'production' ? process.env.SAT_SIMULADOR_URL : null;
  if (!base) return SAT_ENDPOINTS;
  return {
    auth: `${base}/Autenticacion/Autenticacion.svc`,
    request: `${base}/SolicitaDescargaService.svc`,
    verify: `${base}/VerificaSolicitudDescargaService.svc`,
    download: `${base}/DescargaMasivaService.svc`,
  };
}

function exigirNegocio(negocioId, fn) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error(`${fn}: negocioId requerido`);
  return negocioId.trim();
}

// ─── Caché de credenciales POR NEGOCIO ───────────────────────────────────────
const _credCache = new Map(); // negocioId -> { db, t }
const CRED_CACHE_TTL = 5 * 60 * 1000;

/** Invalida el caché de un negocio (o de todos) tras guardar o borrar su e.firma. */
export function invalidarCacheCredenciales(negocioId = null) {
  if (negocioId) _credCache.delete(String(negocioId).trim());
  else _credCache.clear();
}

// ─── Normalizar buffer a DER binario (detecta si viene en PEM) ───────────────
function normalizarDer(buf) {
  const preview = buf.slice(0, 30).toString('utf8').trim();
  if (preview.startsWith('-----BEGIN')) {
    const b64 = buf.toString('utf8')
      .replace(/-----BEGIN[^-]+-----/g, '')
      .replace(/-----END[^-]+-----/g, '')
      .replace(/\s+/g, '');
    return Buffer.from(b64, 'base64');
  }
  return buf;
}

function certDesdeBase64(b64) {
  const pem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
  return new crypto.X509Certificate(pem);
}

// ─── Respaldo de DESARROLLO: env vars o certs/ (nunca en producción) ─────────
function cargarCertificado(rfc) {
  let raw;
  if (process.env.SAT_CERT_BASE64) {
    raw = Buffer.from(process.env.SAT_CERT_BASE64.replace(/\s+/g, ''), 'base64');
  } else {
    const cerPath = path.join(CERTS_DIR, `${rfc.toUpperCase()}.cer`);
    if (!fs.existsSync(cerPath)) throw new Error(`Certificado no encontrado en ${cerPath}`);
    raw = fs.readFileSync(cerPath);
  }
  const der = normalizarDer(raw);
  const b64 = der.toString('base64');
  const cert = certDesdeBase64(b64);
  return { der, cert, expiration: new Date(cert.validTo), base64: b64 };
}

async function cargarLlavePrivada(rfc) {
  const password = process.env.SAT_KEY_PASSWORD;
  if (!password) throw new Error('Variable SAT_KEY_PASSWORD no configurada');
  let der;
  if (process.env.SAT_KEY_BASE64) {
    der = normalizarDer(Buffer.from(process.env.SAT_KEY_BASE64.replace(/\s+/g, ''), 'base64'));
  } else {
    const keyPath = path.join(CERTS_DIR, `${rfc.toUpperCase()}.key`);
    if (!fs.existsSync(keyPath)) throw new Error(`Llave privada no encontrada en ${keyPath}`);
    der = fs.readFileSync(keyPath);
  }
  const forge = (await import('node-forge')).default;
  const pkInfo = forge.pki.decryptPrivateKeyInfo(forge.asn1.fromDer(der.toString('binary')), password);
  if (!pkInfo) throw new Error('Contraseña incorrecta o llave corrupta');
  return { privateKeyPem: forge.pki.privateKeyToPem(forge.pki.privateKeyFromAsn1(pkInfo)) };
}

/**
 * e.firma del negocio: { cerB64, cert, privateKeyPem }. Lanza un error claro si
 * no hay, si no se puede descifrar o si está vencida.
 */
async function obtenerCredencialesCompletas(negocioId, rfc) {
  const nid = exigirNegocio(negocioId, 'obtenerCredencialesCompletas');
  const now = Date.now();
  let entrada = _credCache.get(nid);
  if (!entrada || now - entrada.t > CRED_CACHE_TTL) {
    const { cargarCredencialesSATdb } = await import('./satCredentials.js');
    let db;
    try { db = await cargarCredencialesSATdb(nid); }
    catch (e) {
      throw Object.assign(new Error('No se pudo leer la e.firma guardada de este negocio; vuelve a subirla.'), { codigo: 'EFIRMA_ILEGIBLE', causa: e.message });
    }
    entrada = db ? { db, t: now } : null;
    if (entrada) _credCache.set(nid, entrada); else _credCache.delete(nid);
  }

  let cerB64, cert, privateKeyPem;
  if (entrada) {
    cerB64 = entrada.db.certBase64;
    privateKeyPem = entrada.db.privateKeyPem;
    cert = certDesdeBase64(cerB64);
  } else if (process.env.NODE_ENV !== 'production' && rfc) {
    const cerData = cargarCertificado(rfc);
    cerB64 = cerData.base64; cert = cerData.cert;
    privateKeyPem = (await cargarLlavePrivada(rfc)).privateKeyPem;
  } else {
    throw Object.assign(new Error('Este negocio no tiene e.firma cargada.'), { codigo: 'EFIRMA_NO_CONFIGURADA' });
  }
  const expiration = new Date(cert.validTo);
  if (expiration < new Date()) throw Object.assign(new Error(`La e.firma venció el ${expiration.toISOString().slice(0, 10)}.`), { codigo: 'EFIRMA_VENCIDA' });
  return { cerB64, cert, privateKeyPem, expiration };
}

// ─── Utilidades ──────────────────────────────────────────────────────────────
function isoNow(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

// Equivalente a Helpers::nospaces de phpcfdi.
function nospaces(xml) {
  return xml.replace(/^[^\S\n]*/mg, '').replace(/[^\S\n]*\r?\n/mg, '');
}

// Valor de atributo XML (un RFC con «&» rompía la petición).
function xmlAttr(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Error de red/HTTP del SAT con un mensaje que nunca queda vacío.
function errorSat(etapa, e) {
  const status = e?.response?.status;
  const cuerpo = e?.response?.data ? String(e.response.data).substring(0, 800) : '';
  const causa = cuerpo || e?.message || e?.code || (e?.errors?.map?.((x) => x.code || x.message).join(', ')) || 'sin detalle';
  return Object.assign(new Error(`SAT ${etapa} HTTP ${status ?? e?.code ?? 'ERR'}: ${causa}`), { codigo: String(status ?? e?.code ?? 'RED'), etapa });
}

/**
 * Firma de un cuerpo SOAP (phpcfdi createSignature): digest SHA-1 del XML
 * compacto, SignedInfo exc-c14n firmado RSA-SHA1, KeyInfo con el certificado.
 */
function firmarCuerpo(toDigestXml, { cerB64, privateKeyPem }) {
  const digest = crypto.createHash('sha1').update(Buffer.from(nospaces(toDigestXml), 'utf8')).digest('base64');
  const signedInfoWithNs = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
  const signer = crypto.createSign('SHA1');
  signer.update(signedInfoWithNs);
  const signatureB64 = signer.sign(privateKeyPem, 'base64');
  const signedInfoFinal = signedInfoWithNs.replace('<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">', '<SignedInfo>');
  return nospaces(
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `${signedInfoFinal}` +
    `<SignatureValue>${signatureB64}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${cerB64}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`
  );
}

function sobre(cuerpo) {
  return nospaces(`<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:des="${NS_DES}" xmlns:xd="http://www.w3.org/2000/09/xmldsig#">
<s:Header/>
<s:Body>
${cuerpo}
</s:Body>
</s:Envelope>`);
}

// ─── Autenticación (sin cambios de formato) ──────────────────────────────────
async function construirSoapAuth(negocioId, rfc) {
  const { cerB64, cert, privateKeyPem } = await obtenerCredencialesCompletas(negocioId, rfc);

  // La llave privada debe corresponder al certificado ANTES de enviar al SAT.
  const testData = Buffer.from('xabor-efirma-check');
  const sig = crypto.sign('sha256', testData, crypto.createPrivateKey(privateKeyPem));
  if (!crypto.verify('sha256', testData, cert.publicKey, sig)) {
    throw Object.assign(new Error('La llave privada de la e.firma no corresponde a su certificado.'), { codigo: 'EFIRMA_NO_CORRESPONDE' });
  }

  const created = isoNow();
  const expires = isoNow(300);
  const tsId = '_0';
  const tsXml = `<u:Timestamp xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" u:Id="${tsId}"><u:Created>${created}</u:Created><u:Expires>${expires}</u:Expires></u:Timestamp>`;
  const tsDigest = crypto.createHash('sha1').update(tsXml).digest('base64');
  const signedInfoXml = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod><Reference URI="#${tsId}"><Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>${tsDigest}</DigestValue></Reference></SignedInfo>`;
  const signer = crypto.createSign('SHA1');
  signer.update(signedInfoXml);
  const signatureB64 = signer.sign(privateKeyPem, 'base64');

  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
  <s:Header>
    <o:Security xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" s:mustUnderstand="1">
      ${tsXml}
      <o:BinarySecurityToken u:Id="X509Token" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3" EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${cerB64}</o:BinarySecurityToken>
      <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
        ${signedInfoXml}
        <SignatureValue>${signatureB64}</SignatureValue>
        <KeyInfo>
          <o:SecurityTokenReference>
            <o:Reference URI="#X509Token" ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"/>
          </o:SecurityTokenReference>
        </KeyInfo>
      </Signature>
    </o:Security>
  </s:Header>
  <s:Body>
    <Autentica xmlns="http://DescargaMasivaTerceros.gob.mx"/>
  </s:Body>
</s:Envelope>`;
}

/** Token del SAT (válido 5 min). */
export async function autenticar(negocioId, rfc) {
  const soap = await construirSoapAuth(negocioId, rfc);
  let res;
  try {
    res = await axios.post(urls().auth, soap, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: ACCION.autentica },
      timeout: 30000,
    });
  } catch (e) { throw errorSat('auth', e); }
  const token = extraerValorXml(String(res.data), 'AutenticaResult');
  if (!token) throw Object.assign(new Error('SAT no devolvió token. Respuesta: ' + String(res.data).substring(0, 500)), { codigo: 'SIN_TOKEN' });
  return token;
}

// ─── Solicitud de descarga de RECIBIDOS ──────────────────────────────────────
/**
 * Devuelve el IdSolicitud. Si el SAT no acepta, lanza un error con
 * `codEstatus` y `mensajeSat` (5002 agotada, 5004 sin datos, 5005 duplicada...).
 */
export async function solicitarDescarga(negocioId, rfc, token, fechaInicial, fechaFinal, tipoComprobante = null) {
  const rfcSolicitante = rfc.toUpperCase();
  const creds = await obtenerCredencialesCompletas(negocioId, rfc);

  // Atributos en orden ALFABÉTICO (ksort de phpcfdi). El SAT espera
  // EstadoComprobante en texto ('Vigente'); recibidos cancelados no se entregan.
  const attrs = {
    EstadoComprobante: 'Vigente',
    FechaFinal: fechaFinal,
    FechaInicial: fechaInicial,
    RfcReceptor: rfcSolicitante,
    RfcSolicitante: rfcSolicitante,
    TipoSolicitud: 'CFDI',
    ...(tipoComprobante ? { TipoComprobante: tipoComprobante } : {}),
  };
  const sortedAttrStr = Object.keys(attrs).sort().map((k) => `${k}="${xmlAttr(attrs[k])}"`).join(' ');
  const signatureXml = firmarCuerpo(
    `<des:SolicitaDescargaRecibidos xmlns:des="${NS_DES}"><des:solicitud ${sortedAttrStr}></des:solicitud></des:SolicitaDescargaRecibidos>`, creds);
  const soap = sobre(`<des:SolicitaDescargaRecibidos>
<des:solicitud ${sortedAttrStr}>${signatureXml}</des:solicitud>
</des:SolicitaDescargaRecibidos>`);

  let res;
  try {
    res = await axios.post(urls().request, soap, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: ACCION.solicitaRecibidos, Authorization: `WRAP access_token="${token}"` },
      timeout: 30000,
    });
  } catch (e) { throw errorSat('solicitud', e); }

  const xml = String(res.data);
  const idSolicitud = extraerAtributoXml(xml, 'SolicitaDescargaRecibidosResult', 'IdSolicitud');
  const codEstatus = extraerAtributoXml(xml, 'SolicitaDescargaRecibidosResult', 'CodEstatus');
  const mensaje = extraerAtributoXml(xml, 'SolicitaDescargaRecibidosResult', 'Mensaje');
  if (codEstatus !== '5000' || !idSolicitud) {
    throw Object.assign(new Error(`SAT rechazó la solicitud [${codEstatus}]: ${mensaje}`), { codEstatus, mensajeSat: mensaje, codigo: codEstatus || 'SIN_CODIGO' });
  }
  return idSolicitud;
}

// ─── Verificación (firmada como la solicitud; phpcfdi verify) ────────────────
// EstadoSolicitud: 1 aceptada, 2 en proceso, 3 terminada, 4 error, 5 rechazada, 6 vencida.
export async function verificarSolicitud(negocioId, rfc, token, idSolicitud) {
  const creds = await obtenerCredencialesCompletas(negocioId, rfc);
  const attrs = `IdSolicitud="${xmlAttr(idSolicitud)}" RfcSolicitante="${xmlAttr(rfc.toUpperCase())}"`;
  const signatureXml = firmarCuerpo(
    `<des:VerificaSolicitudDescarga xmlns:des="${NS_DES}"><des:solicitud ${attrs}></des:solicitud></des:VerificaSolicitudDescarga>`, creds);
  const soap = sobre(`<des:VerificaSolicitudDescarga>
<des:solicitud ${attrs}>${signatureXml}</des:solicitud>
</des:VerificaSolicitudDescarga>`);

  let res;
  try {
    res = await axios.post(urls().verify, soap, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: ACCION.verifica, Authorization: `WRAP access_token="${token}"` },
      timeout: 30000,
    });
  } catch (e) { throw errorSat('verificación', e); }

  const xml = String(res.data);
  const codEstatus = extraerAtributoXml(xml, 'VerificaSolicitudDescargaResult', 'CodEstatus');
  const estadoSolicitud = extraerAtributoXml(xml, 'VerificaSolicitudDescargaResult', 'EstadoSolicitud');
  const codEstadoSol = extraerAtributoXml(xml, 'VerificaSolicitudDescargaResult', 'CodigoEstadoSolicitud');
  const numCfdis = extraerAtributoXml(xml, 'VerificaSolicitudDescargaResult', 'NumeroCFDIs');
  const mensaje = extraerAtributoXml(xml, 'VerificaSolicitudDescargaResult', 'Mensaje');
  const packageIds = [];
  const pkgRegex = /<(?:\w+:)?IdsPaquetes>([^<]+)<\/(?:\w+:)?IdsPaquetes>/g;
  let m;
  while ((m = pkgRegex.exec(xml)) !== null) packageIds.push(m[1].trim());

  const aceptada = codEstatus === '5000';
  return {
    codEstatus, estadoSolicitud, codEstadoSol, mensaje,
    numCfdis: parseInt(numCfdis, 10) || 0,
    packageIds,
    aceptada,
    terminada: aceptada && estadoSolicitud === '3',
    error: !aceptada || ['4', '5', '6'].includes(estadoSolicitud),
  };
}

// ─── Descarga de un paquete (phpcfdi download; acción «Descargar») ───────────
// El código de estatus viene en el encabezado <h:respuesta>, no en el cuerpo.
export async function descargarPaquete(negocioId, rfc, token, packageId) {
  const creds = await obtenerCredencialesCompletas(negocioId, rfc);
  const attrs = `IdPaquete="${xmlAttr(packageId)}" RfcSolicitante="${xmlAttr(rfc.toUpperCase())}"`;
  const signatureXml = firmarCuerpo(
    `<des:PeticionDescargaMasivaTercerosEntrada xmlns:des="${NS_DES}"><des:peticionDescarga ${attrs}></des:peticionDescarga></des:PeticionDescargaMasivaTercerosEntrada>`, creds);
  const soap = sobre(`<des:PeticionDescargaMasivaTercerosEntrada>
<des:peticionDescarga ${attrs}>${signatureXml}</des:peticionDescarga>
</des:PeticionDescargaMasivaTercerosEntrada>`);

  let res;
  try {
    res = await axios.post(urls().download, soap, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: ACCION.descarga, Authorization: `WRAP access_token="${token}"` },
      timeout: 120000,
      maxContentLength: 200 * 1024 * 1024,
    });
  } catch (e) { throw errorSat('descarga', e); }

  const xml = String(res.data);
  const encabezado = (xml.match(/<(?:\w+:)?respuesta\b[^>]*>/) || [''])[0];
  const atributo = (a) => (encabezado.match(new RegExp(`\\s${a}="([^"]*)"`)) || [])[1] || null;
  const codEstatus = atributo('CodEstatus');
  const mensaje = atributo('Mensaje');
  const paqueteB64 = extraerValorXml(xml, 'Paquete');
  if (codEstatus !== '5000' || !paqueteB64) {
    throw Object.assign(new Error(`Error descargando paquete [${codEstatus}]: ${mensaje}`), { codEstatus, mensajeSat: mensaje, codigo: codEstatus || 'SIN_PAQUETE' });
  }
  return Buffer.from(paqueteB64.replace(/\s+/g, ''), 'base64');
}

// ─── Extraer XMLs de un ZIP ──────────────────────────────────────────────────
export async function extraerXmlsDeZip(zipBuffer) {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(zipBuffer);
  const xmls = [];
  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith('.xml') && !entry.isDirectory) {
      xmls.push({ nombre: entry.entryName, xml: zip.readAsText(entry) });
    }
  }
  return xmls;
}

// ─── Parsear CFDI XML → objeto plano ─────────────────────────────────────────
export function parsearCFDI(xmlStr) {
  const comprobante = extraerAtributosNodo(xmlStr, 'cfdi:Comprobante', 'Comprobante');
  const tfd = extraerAtributosNodo(xmlStr, 'tfd:TimbreFiscalDigital', 'TimbreFiscalDigital');
  const emisor = extraerAtributosNodo(xmlStr, 'cfdi:Emisor', 'Emisor');
  const receptor = extraerAtributosNodo(xmlStr, 'cfdi:Receptor', 'Receptor');

  // Impuestos del COMPROBANTE: en CFDI 4.0 el primer <cfdi:Impuestos> es el de
  // un concepto y no trae totales; el del comprobante es el que los lleva.
  const nodosImpuestos = xmlStr.match(/<cfdi:Impuestos\b[^>]*>/g) || [];
  const delComprobante = nodosImpuestos.find((n) => /\sTotalImpuestos(?:Trasladados|Retenidos)="/.test(n)) || '';
  const attrDe = (nodo, a) => (nodo.match(new RegExp(`\\s${a}="([^"]*)"`)) || [])[1];

  return {
    uuid: tfd.UUID || tfd.Uuid || '',
    version_cfdi: comprobante.Version || comprobante.version || '4.0',
    fecha_emision: comprobante.Fecha || comprobante.fecha || null,
    fecha_timbrado: tfd.FechaTimbrado || null,
    rfc_emisor: emisor.Rfc || emisor.RFC || '',
    nombre_emisor: emisor.Nombre || '',
    rfc_receptor: receptor.Rfc || receptor.RFC || '',
    nombre_receptor: receptor.Nombre || '',
    subtotal: parseFloat(comprobante.SubTotal || comprobante.Subtotal || '0'),
    descuento: parseFloat(comprobante.Descuento || '0'),
    impuestos_trasladados: parseFloat(attrDe(delComprobante, 'TotalImpuestosTrasladados') || '0'),
    impuestos_retenidos: parseFloat(attrDe(delComprobante, 'TotalImpuestosRetenidos') || '0'),
    total: parseFloat(comprobante.Total || comprobante.total || '0'),
    moneda: comprobante.Moneda || 'MXN',
    tipo_cambio: parseFloat(comprobante.TipoCambio || '1'),
    tipo_comprobante: comprobante.TipoDeComprobante || comprobante.tipoDeComprobante || 'I',
    metodo_pago: comprobante.MetodoPago || null,
    forma_pago: comprobante.FormaPago || null,
    uso_cfdi: receptor.UsoCFDI || null,
    serie: comprobante.Serie || null,
    folio: comprobante.Folio || null,
    exportacion: comprobante.Exportacion || null,
    items: parsearConceptos(xmlStr),
  };
}

// ─── Helpers de parseo XML ───────────────────────────────────────────────────
function extraerAtributoXml(xml, tag, attr) {
  const tagRegex = new RegExp(`<[^>]*${escRe(tag)}[^>]*>|<[^/][^>]*${escRe(tag)}[^>]*/>`, 'i');
  const tagMatch = xml.match(tagRegex);
  if (!tagMatch) return null;
  const attrMatch = tagMatch[0].match(new RegExp(`\\s${escRe(attr)}="([^"]*)"`, 'i'));
  return attrMatch ? attrMatch[1] : null;
}

function extraerValorXml(xml, tag) {
  const m = xml.match(new RegExp(`<[^>]*${escRe(tag)}[^>]*>([\\s\\S]*?)<\\/[^>]*${escRe(tag)}>`, 'i'));
  return m ? m[1].trim() : null;
}

function extraerAtributosNodo(xml, tag1, tag2) {
  const m = xml.match(new RegExp(`<(?:${escRe(tag1)}|${escRe(tag2)})(\\s[^>]*)(?:/>|>)`, 'i'));
  if (!m || !m[1]) return {};
  const attrs = {};
  const attrPattern = /\s([\w:]+)="([^"]*)"/g;
  let am;
  while ((am = attrPattern.exec(m[1])) !== null) attrs[am[1].replace(/^[^:]+:/, '')] = am[2];
  return attrs;
}

// <cfdi:Concepto ...> exige un espacio tras el nombre: <cfdi:Conceptos> ya no
// cuenta como una partida vacía.
function parsearConceptos(xml) {
  const items = [];
  const conceptoRegex = /<cfdi:Concepto(\s[^>]*?)\/?>/g;
  let m;
  while ((m = conceptoRegex.exec(xml)) !== null) {
    const attr = {};
    const ap = /\s([\w:]+)="([^"]*)"/g;
    let am;
    while ((am = ap.exec(m[1])) !== null) attr[am[1].replace(/^[^:]+:/, '')] = am[2];
    items.push({
      clave_prod_serv: attr.ClaveProdServ || null,
      no_identificacion: attr.NoIdentificacion || null,
      descripcion: attr.Descripcion || '',
      cantidad: parseFloat(attr.Cantidad || '1'),
      clave_unidad: attr.ClaveUnidad || null,
      unidad: attr.Unidad || null,
      valor_unitario: parseFloat(attr.ValorUnitario || '0'),
      importe: parseFloat(attr.Importe || '0'),
      descuento: parseFloat(attr.Descuento || '0'),
      objeto_impuesto: attr.ObjetoImp || null,
    });
  }
  return items;
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * e.firma del negocio vigente y del RFC indicado (el que se usa para firmar,
 * no un certificado de variables de entorno).
 */
export async function validarCertificado(negocioId, rfc) {
  const { cert, expiration } = await obtenerCredencialesCompletas(negocioId, rfc);
  if (rfc && !cert.subject.toUpperCase().includes(String(rfc).toUpperCase())) {
    throw Object.assign(new Error(`La e.firma cargada no corresponde al RFC ${rfc}.`), { codigo: 'EFIRMA_OTRO_RFC' });
  }
  return { valido: true, expiration };
}

export { cargarCertificado };
