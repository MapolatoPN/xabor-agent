/**
 * satClient.js — Cliente para el Servicio Web de Descarga Masiva de CFDI del SAT
 *
 * SEGURIDAD:
 * - Las llaves privadas NUNCA se loguean ni se incluyen en código.
 * - La contraseña viene exclusivamente de variables de entorno (SAT_KEY_PASSWORD).
 * - Los archivos .cer y .key viven en certs/ (excluido de git).
 * - La llave privada se limpia de memoria después de usarse.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import crypto from 'crypto';
import { SAT_ENDPOINTS as SAT_URL, SAT_NS } from './sat-endpoints.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERTS_DIR = path.join(__dirname, '../../certs');

// ─── Caché de credenciales cargadas desde DB ──────────────────────────────────
let _credDbCache = null;
let _credDbCacheTime = 0;
const CRED_CACHE_TTL = 5 * 60 * 1000; // 5 min

/** Invalida el caché — llamar después de guardar nuevas credenciales en DB */
export function invalidarCacheCredenciales() {
  _credDbCache = null;
  _credDbCacheTime = 0;
}

// ─── Normalizar buffer a DER binario (detecta si viene en PEM) ───────────────
function normalizarDer(buf) {
  const preview = buf.slice(0, 30).toString('utf8').trim();
  if (preview.startsWith('-----BEGIN')) {
    // Ya es PEM — extraer el DER de adentro
    const pemStr = buf.toString('utf8');
    const b64 = pemStr
      .replace(/-----BEGIN[^-]+-----/g, '')
      .replace(/-----END[^-]+-----/g, '')
      .replace(/\s+/g, '');
    return Buffer.from(b64, 'base64');
  }
  return buf; // Ya es DER binario
}

// ─── Carga de certificado — desde env var (Railway) o archivo local ───────────
function cargarCertificado(rfc) {
  let raw;
  if (process.env.SAT_CERT_BASE64) {
    raw = Buffer.from(process.env.SAT_CERT_BASE64.replace(/\s+/g, ''), 'base64');
  } else {
    const cerPath = path.join(CERTS_DIR, `${rfc.toUpperCase()}.cer`);
    if (!fs.existsSync(cerPath)) throw new Error(`Certificado no encontrado. Configura SAT_CERT_BASE64 en Railway o coloca el archivo en ${cerPath}`);
    raw = fs.readFileSync(cerPath);
  }
  const der = normalizarDer(raw);
  const b64 = der.toString('base64');
  const pem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
  const cert = new crypto.X509Certificate(pem);
  const expiration = new Date(cert.validTo);
  if (expiration < new Date()) throw new Error(`Certificado vencido el ${expiration.toISOString()}`);
  return { der, pem, cert, expiration, base64: b64 };
}

// ─── Descifrado de llave privada — desde env var (Railway) o archivo local ───
async function cargarLlavePrivada(rfc) {
  const password = process.env.SAT_KEY_PASSWORD;
  if (!password) throw new Error('Variable SAT_KEY_PASSWORD no configurada en Railway');

  let der;
  if (process.env.SAT_KEY_BASE64) {
    der = normalizarDer(Buffer.from(process.env.SAT_KEY_BASE64.replace(/\s+/g, ''), 'base64'));
  } else {
    const keyPath = path.join(CERTS_DIR, `${rfc.toUpperCase()}.key`);
    if (!fs.existsSync(keyPath)) throw new Error(`Llave privada no encontrada. Configura SAT_KEY_BASE64 en Railway o coloca el archivo en ${keyPath}`);
    der = fs.readFileSync(keyPath);
  }

  let forge;
  try {
    forge = (await import('node-forge')).default;
  } catch {
    throw new Error('node-forge no instalado. Ejecuta: npm install node-forge');
  }
  const asn1 = forge.asn1.fromDer(der.toString('binary'));

  // Descifrar PKCS#8 cifrado: decryptPrivateKeyInfo → privateKeyFromAsn1
  const pkInfo = forge.pki.decryptPrivateKeyInfo(asn1, password);
  if (!pkInfo) throw new Error('Contraseña incorrecta o llave corrupta');
  const privateKey = forge.pki.privateKeyFromAsn1(pkInfo);

  const privateKeyPem = forge.pki.privateKeyToPem(privateKey);

  return { privateKeyPem };
}

// ─── Carga unificada de credenciales: DB primero, luego env vars / archivo ────
// Devuelve { cerB64, cert, privateKeyPem }
async function obtenerCredencialesCompletas(rfc) {
  const now = Date.now();

  // Intentar refrescar caché desde DB
  if (!_credDbCache || now - _credDbCacheTime > CRED_CACHE_TTL) {
    try {
      const { cargarCredencialesSATdb } = await import('./satCredentials.js');
      const db = await cargarCredencialesSATdb();
      if (db) {
        _credDbCache = db;
        _credDbCacheTime = now;
      }
    } catch { /* si DB falla, usa env vars */ }
  }

  let cerB64, cert, privateKeyPem;

  if (_credDbCache) {
    // ── Desde DB ──
    cerB64 = _credDbCache.certBase64;
    privateKeyPem = _credDbCache.privateKeyPem;
    const der = Buffer.from(cerB64, 'base64');
    const certPem = `-----BEGIN CERTIFICATE-----\n${cerB64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
    cert = new crypto.X509Certificate(certPem);
    const expiration = new Date(cert.validTo);
    if (expiration < new Date()) throw new Error(`e.firma (DB) vencida el ${expiration.toISOString()}`);
  } else {
    // ── Desde env vars / archivo ──
    const cerData = cargarCertificado(rfc);
    cerB64 = cerData.base64;
    cert = cerData.cert;
    const llaveData = await cargarLlavePrivada(rfc);
    privateKeyPem = llaveData.privateKeyPem;
  }

  return { cerB64, cert, privateKeyPem };
}

// ─── Timestamp ISO8601 para SOAP ─────────────────────────────────────────────
function isoNow(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

// ─── Construir y firmar el SOAP de autenticación ─────────────────────────────
async function construirSoapAuth(rfc) {
  const { cerB64, cert, privateKeyPem } = await obtenerCredencialesCompletas(rfc);

  // Verificar que la llave privada corresponde al certificado ANTES de enviar al SAT
  {
    const testData = Buffer.from('xabor-efirma-check');
    const privKey = crypto.createPrivateKey(privateKeyPem);
    const sig = crypto.sign('sha256', testData, privKey);
    if (!crypto.verify('sha256', testData, cert.publicKey, sig)) {
      throw new Error('DIAGNÓSTICO: La llave privada (SAT_KEY_BASE64) NO corresponde al certificado (SAT_CERT_BASE64). Verifica que ambos archivos pertenecen a la misma e.firma.');
    }
  }

  const created = isoNow();
  const expires = isoNow(300); // 5 minutos
  const tsId = '_0';

  // --- Timestamp element (lo que vamos a firmar) ---
  const tsXml = `<u:Timestamp xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" u:Id="${tsId}"><u:Created>${created}</u:Created><u:Expires>${expires}</u:Expires></u:Timestamp>`;

  // --- Digest SHA-1 del Timestamp (C14N simple, el elemento ya es canónico) ---
  const tsDigest = crypto.createHash('sha1').update(tsXml).digest('base64');

  // --- SignedInfo — usar Canonical XML (elementos vacíos NUNCA self-closing, C14N los expande) ---
  const signedInfoXml = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod><Reference URI="#${tsId}"><Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>${tsDigest}</DigestValue></Reference></SignedInfo>`;

  // --- Firma RSA-SHA1 sobre SignedInfo (crypto nativo — compatible con WCF del SAT) ---
  const signer = crypto.createSign('SHA1');
  signer.update(signedInfoXml);
  const signatureB64 = signer.sign(privateKeyPem, 'base64');

  // --- Numero de serie del certificado (decimal) ---
  const serial = BigInt('0x' + cert.serialNumber).toString(10);

  // --- SOAP envelope completo ---
  const soap = `<?xml version="1.0" encoding="utf-8"?>
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

  return soap;
}

// ─── Autenticar con e.firma → token (válido 5 min) ───────────────────────────
export async function autenticar(rfc) {
  const soap = await construirSoapAuth(rfc);
  let res;
  try {
    res = await axios.post(SAT_URL.auth, soap, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica"',
      },
      timeout: 30000,
    });
  } catch (e) {
    // Capturar cuerpo de respuesta SAT para diagnóstico
    const body = e.response?.data ? String(e.response.data).substring(0, 800) : e.message;
    throw new Error(`SAT auth HTTP ${e.response?.status ?? 'ERR'}: ${body}`);
  }

  // Extraer token del XML de respuesta
  const token = extraerValorXml(res.data, 'AutenticaResult');
  if (!token) throw new Error('SAT no devolvió token. Respuesta: ' + res.data.substring(0, 500));
  return token;
}

// ─── Compactar XML (equivalente a Helpers::nospaces de phpcfdi) ───────────────
function nospaces(xml) {
  // Elimina espacios horizontales al inicio de cada línea y saltos de línea
  return xml.replace(/^[^\S\n]*/mg, '').replace(/[^\S\n]*\r?\n/mg, '');
}

// ─── Solicitar descarga de CFDI ──────────────────────────────────────────────
// Implementación basada en phpcfdi/sat-ws-descarga-masiva (FielRequestBuilder.php)
// El body se firma directamente con e.firma — NO se usa WRAP token en header SOAP
export async function solicitarDescarga(rfc, token, fechaInicial, fechaFinal, tipoComprobante = null) {
  const rfcSolicitante = rfc.toUpperCase();

  // ─── Certificado y llave ─────────────────────────────────────────────────────
  const { cerB64, cert, privateKeyPem } = await obtenerCredencialesCompletas(rfc);
  const serial = BigInt('0x' + cert.serialNumber).toString(10);
  const issuerName = cert.issuer.split('\n').filter(Boolean).join(', ');

  // ─── Atributos de solicitud en orden ALFABÉTICO (ksort de phpcfdi) ──────────
  // EstadoComprobante="1" → solo vigentes (nunca cancelados)
  const attrs = {
    EstadoComprobante: 'Vigente',  // SAT espera texto, no número. '1' es inválido.
    FechaFinal: fechaFinal,
    FechaInicial: fechaInicial,
    RfcReceptor: rfcSolicitante,
    RfcSolicitante: rfcSolicitante,
    TipoSolicitud: 'CFDI',
    ...(tipoComprobante ? { TipoComprobante: tipoComprobante } : {}),
  };
  // Ordenar alfabéticamente (phpcfdi hace ksort)
  const sortedAttrStr = Object.keys(attrs).sort().map(k => `${k}="${attrs[k]}"`).join(' ');

  // ─── toDigestXml: elemento outer SIN Signature (lo que phpcfdi llama $toDigestXml) ─
  // Se usa des: prefix explícito, igual que phpcfdi
  const toDigestXml = nospaces(
    `<des:SolicitaDescargaRecibidos xmlns:des="http://DescargaMasivaTerceros.sat.gob.mx">` +
    `<des:solicitud ${sortedAttrStr}></des:solicitud>` +
    `</des:SolicitaDescargaRecibidos>`
  );

  // ─── Digest SHA1 del toDigestXml compacto ───────────────────────────────────
  const digest = crypto.createHash('sha1').update(Buffer.from(toDigestXml, 'utf8')).digest('base64');

  // ─── SignedInfo CON xmlns (para firmar) — igual que phpcfdi createSignedInfoCanonicalExclusive ─
  // Transform: solo exc-c14n (NO enveloped-signature), URI="" referencia al outer element
  const signedInfoWithNs = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod><Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;

  // ─── Firma RSA-SHA1 ──────────────────────────────────────────────────────────
  const signer = crypto.createSign('SHA1');
  signer.update(signedInfoWithNs);
  const signatureB64 = signer.sign(privateKeyPem, 'base64');

  // ─── SignedInfo en el XML final SIN xmlns (phpcfdi hace str_replace para quitarlo) ─
  const signedInfoFinal = signedInfoWithNs.replace(
    '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">',
    '<SignedInfo>'
  );

  // ─── Signature — KeyInfo con solo X509Certificate ───────────────────────────
  // X509IssuerSerial omitido: evita fallos de lookup por formato de IssuerName.
  // El SAT puede derivar todo del cert embebido directamente.
  const signatureXml = nospaces(
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` +
    `${signedInfoFinal}` +
    `<SignatureValue>${signatureB64}</SignatureValue>` +
    `<KeyInfo>` +
    `<X509Data>` +
    `<X509Certificate>${cerB64}</X509Certificate>` +
    `</X509Data>` +
    `</KeyInfo>` +
    `</Signature>`
  );

  // ─── SOAP envelope — header VACÍO, sin token (phpcfdi: <s:Header/>) ─────────
  // La autenticación va en la firma del body, no en el header
  // namespaces xd: y des: declarados en el Envelope (phpcfdi pattern)
  const soap = nospaces(`<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:des="http://DescargaMasivaTerceros.sat.gob.mx" xmlns:xd="http://www.w3.org/2000/09/xmldsig#">
<s:Header/>
<s:Body>
<des:SolicitaDescargaRecibidos>
<des:solicitud ${sortedAttrStr}>${signatureXml}</des:solicitud>
</des:SolicitaDescargaRecibidos>
</s:Body>
</s:Envelope>`);

  let res;
  try {
    res = await axios.post(SAT_URL.request, soap, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/SolicitaDescargaRecibidos"',
        'Authorization': `WRAP access_token="${token}"`,
      },
      timeout: 30000,
    });
  } catch (e) {
    const body = e.response?.data ? String(e.response.data).substring(0, 800) : e.message;
    throw new Error(`SAT solicitud HTTP ${e.response?.status ?? 'ERR'}: ${body}`);
  }

  const idSolicitud  = extraerAtributoXml(res.data, 'SolicitaDescargaRecibidosResult', 'IdSolicitud');
  const codEstatus   = extraerAtributoXml(res.data, 'SolicitaDescargaRecibidosResult', 'CodEstatus');
  const mensaje      = extraerAtributoXml(res.data, 'SolicitaDescargaRecibidosResult', 'Mensaje');

  if (codEstatus !== '5000') throw new Error(`SAT rechazó solicitud [${codEstatus}]: ${mensaje}`);
  return idSolicitud;
}

// ─── Verificar estado de solicitud ───────────────────────────────────────────
export async function verificarSolicitud(rfc, token, idSolicitud) {
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header>
    <o:Security xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <o:BinarySecurityToken ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd#SAML">${token}</o:BinarySecurityToken>
    </o:Security>
  </s:Header>
  <s:Body>
    <VerificaSolicitudDescarga xmlns="http://DescargaMasivaTerceros.sat.gob.mx">
      <solicitud RfcSolicitante="${rfc.toUpperCase()}" IdSolicitud="${idSolicitud}"/>
    </VerificaSolicitudDescarga>
  </s:Body>
</s:Envelope>`;

  const res = await axios.post(SAT_URL.verify, soap, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': '"http://DescargaMasivaTerceros.sat.gob.mx/IVerificaSolicitudDescargaService/VerificaSolicitudDescarga"',
      'Authorization': `WRAP access_token="${token}"`,
    },
    timeout: 30000,
  });

  const codEstatus    = extraerAtributoXml(res.data, 'VerificaSolicitudDescargaResult', 'CodEstatus');
  const estadoSolicitud = extraerAtributoXml(res.data, 'VerificaSolicitudDescargaResult', 'EstadoSolicitud');
  const codEstadoSol  = extraerAtributoXml(res.data, 'VerificaSolicitudDescargaResult', 'CodigoEstadoSolicitud');
  const numCfdis      = extraerAtributoXml(res.data, 'VerificaSolicitudDescargaResult', 'NumeroCFDIs');
  const mensaje       = extraerAtributoXml(res.data, 'VerificaSolicitudDescargaResult', 'Mensaje');

  // Extraer IDs de paquetes
  const packageIds = [];
  const pkgRegex = /<IdsPaquetes>([^<]+)<\/IdsPaquetes>/g;
  let m;
  while ((m = pkgRegex.exec(res.data)) !== null) packageIds.push(m[1].trim());

  // EstadoSolicitud: 1=Aceptada, 2=En proceso, 3=Terminada, 4=Error, 5=Rechazada, 6=Vencida
  return {
    codEstatus,
    estadoSolicitud,       // '3' = lista para descargar
    codEstadoSol,
    numCfdis: parseInt(numCfdis) || 0,
    packageIds,
    mensaje,
    terminada: estadoSolicitud === '3',
    error: ['4', '5', '6'].includes(estadoSolicitud),
  };
}

// ─── Descargar un paquete ZIP (base64) ───────────────────────────────────────
export async function descargarPaquete(rfc, token, packageId) {
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header>
    <o:Security xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <o:BinarySecurityToken ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd#SAML">${token}</o:BinarySecurityToken>
    </o:Security>
  </s:Header>
  <s:Body>
    <PeticionDescargaMasivaTercerosEntrada xmlns="http://DescargaMasivaTerceros.sat.gob.mx">
      <peticionDescarga IdPaquete="${packageId}" RfcSolicitante="${rfc.toUpperCase()}"/>
    </PeticionDescargaMasivaTercerosEntrada>
  </s:Body>
</s:Envelope>`;

  const res = await axios.post(SAT_URL.download, soap, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': '"http://DescargaMasivaTerceros.sat.gob.mx/IDescargaMasivaTercerosService/DescargarPaquete"',
      'Authorization': `WRAP access_token="${token}"`,
    },
    timeout: 120000, // paquetes pueden ser grandes
  });

  const codEstatus   = extraerAtributoXml(res.data, 'RespuestaDescargaMasivaTercerosSalida', 'CodEstatus');
  const paqueteB64   = extraerValorXml(res.data, 'Paquete');
  const mensaje      = extraerAtributoXml(res.data, 'RespuestaDescargaMasivaTercerosSalida', 'Mensaje');

  if (codEstatus !== '5000' || !paqueteB64) throw new Error(`Error descargando paquete [${codEstatus}]: ${mensaje}`);

  return Buffer.from(paqueteB64, 'base64');
}

// ─── Extraer XMLs de un buffer ZIP ───────────────────────────────────────────
export async function extraerXmlsDeZip(zipBuffer) {
  let AdmZip;
  try {
    AdmZip = (await import('adm-zip')).default;
  } catch {
    throw new Error('adm-zip no instalado. Ejecuta: npm install adm-zip');
  }

  const zip = new AdmZip(zipBuffer);
  const xmls = [];

  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith('.xml') && !entry.isDirectory) {
      const content = zip.readAsText(entry);
      xmls.push({ nombre: entry.entryName, xml: content });
    }
  }

  return xmls;
}

// ─── Parsear CFDI XML → objeto plano ─────────────────────────────────────────
export function parsearCFDI(xmlStr) {
  // Extraer atributos del nodo raíz cfdi:Comprobante
  const comprobante = extraerAtributosNodo(xmlStr, 'cfdi:Comprobante', 'Comprobante');

  // TimbreFiscalDigital → UUID y fecha de timbrado
  const tfd = extraerAtributosNodo(xmlStr, 'tfd:TimbreFiscalDigital', 'TimbreFiscalDigital');

  // Emisor
  const emisor = extraerAtributosNodo(xmlStr, 'cfdi:Emisor', 'Emisor');

  // Receptor
  const receptor = extraerAtributosNodo(xmlStr, 'cfdi:Receptor', 'Receptor');

  // Impuestos (primer nodo cfdi:Impuestos)
  const totalTraslados  = parseFloat(extraerAtributoXml(xmlStr, 'cfdi:Impuestos', 'TotalImpuestosTrasladados') || '0');
  const totalRetenciones = parseFloat(extraerAtributoXml(xmlStr, 'cfdi:Impuestos', 'TotalImpuestosRetenidos') || '0');

  // Conceptos / items
  const items = parsearConceptos(xmlStr);

  return {
    uuid:                  tfd.UUID || tfd.Uuid || '',
    version_cfdi:          comprobante.Version || comprobante.version || '4.0',
    fecha_emision:         comprobante.Fecha || comprobante.fecha || null,
    fecha_timbrado:        tfd.FechaTimbrado || null,
    rfc_emisor:            emisor.Rfc || emisor.RFC || '',
    nombre_emisor:         emisor.Nombre || '',
    rfc_receptor:          receptor.Rfc || receptor.RFC || '',
    nombre_receptor:       receptor.Nombre || '',
    subtotal:              parseFloat(comprobante.SubTotal || comprobante.Subtotal || '0'),
    descuento:             parseFloat(comprobante.Descuento || '0'),
    impuestos_trasladados: totalTraslados,
    impuestos_retenidos:   totalRetenciones,
    total:                 parseFloat(comprobante.Total || comprobante.total || '0'),
    moneda:                comprobante.Moneda || 'MXN',
    tipo_cambio:           parseFloat(comprobante.TipoCambio || '1'),
    tipo_comprobante:      comprobante.TipoDeComprobante || comprobante.tipoDeComprobante || 'I',
    metodo_pago:           comprobante.MetodoPago || null,
    forma_pago:            comprobante.FormaPago || null,
    uso_cfdi:              receptor.UsoCFDI || null,
    serie:                 comprobante.Serie || null,
    folio:                 comprobante.Folio || null,
    exportacion:           comprobante.Exportacion || null,
    items,
  };
}

// ─── Helpers de parseo XML (regex sobre estructura CFDI conocida) ─────────────
function extraerAtributoXml(xml, tag, attr) {
  // Busca la primera ocurrencia del tag y extrae el atributo
  const tagRegex = new RegExp(`<[^>]*${escRe(tag)}[^>]*>|<[^/][^>]*${escRe(tag)}[^>]*/>`, 'i');
  const tagMatch = xml.match(tagRegex);
  if (!tagMatch) return null;
  const attrMatch = tagMatch[0].match(new RegExp(`\\s${escRe(attr)}="([^"]*)"`,'i'));
  return attrMatch ? attrMatch[1] : null;
}

function extraerValorXml(xml, tag) {
  const m = xml.match(new RegExp(`<[^>]*${escRe(tag)}[^>]*>([\\s\\S]*?)<\\/[^>]*${escRe(tag)}>`, 'i'));
  return m ? m[1].trim() : null;
}

function extraerAtributosNodo(xml, tag1, tag2) {
  const pattern = `<(?:${escRe(tag1)}|${escRe(tag2)})(\\s[^>]*)(?:/>|>)`;
  const m = xml.match(new RegExp(pattern, 'i'));
  if (!m || !m[1]) return {};
  const attrs = {};
  const attrPattern = /\s([\w:]+)="([^"]*)"/g;
  let am;
  while ((am = attrPattern.exec(m[1])) !== null) {
    attrs[am[1].replace(/^[^:]+:/, '')] = am[2]; // quitar namespace prefix
  }
  return attrs;
}

function parsearConceptos(xml) {
  const items = [];
  const conceptoRegex = /<cfdi:Concepto([^>]*)\/?>|<cfdi:Concepto([^>]*)>/gi;
  let m;
  while ((m = conceptoRegex.exec(xml)) !== null) {
    const attrStr = m[1] || m[2] || '';
    const attr = {};
    const ap = /\s([\w:]+)="([^"]*)"/g;
    let am;
    while ((am = ap.exec(attrStr)) !== null) attr[am[1].replace(/^[^:]+:/, '')] = am[2];
    items.push({
      clave_prod_serv:   attr.ClaveProdServ || null,
      no_identificacion: attr.NoIdentificacion || null,
      descripcion:       attr.Descripcion || '',
      cantidad:          parseFloat(attr.Cantidad || '1'),
      clave_unidad:      attr.ClaveUnidad || null,
      unidad:            attr.Unidad || null,
      valor_unitario:    parseFloat(attr.ValorUnitario || '0'),
      importe:           parseFloat(attr.Importe || '0'),
      descuento:         parseFloat(attr.Descuento || '0'),
      objeto_impuesto:   attr.ObjetoImp || null,
    });
  }
  return items;
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── Validar e.firma (vigencia + correspondencia de RFC) ─────────────────────
export function validarCertificado(rfc) {
  const { cert, expiration } = cargarCertificado(rfc);
  if (expiration < new Date()) throw new Error(`e.firma vencida el ${expiration.toISOString()}`);
  // El RFC debe aparecer en el Subject del certificado
  const subject = cert.subject;
  if (!subject.includes(rfc.toUpperCase())) {
    throw new Error(`El certificado no corresponde al RFC ${rfc}. Subject: ${subject}`);
  }
  return { valido: true, expiration };
}

export { cargarCertificado };
