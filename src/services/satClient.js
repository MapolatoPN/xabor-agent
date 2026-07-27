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

// ─── Timestamp ISO8601 para SOAP ─────────────────────────────────────────────
function isoNow(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

// ─── Construir y firmar el SOAP de autenticación ─────────────────────────────
async function construirSoapAuth(rfc) {
  const { der: cerDer, base64: cerB64, cert } = cargarCertificado(rfc);
  const { privateKeyPem } = await cargarLlavePrivada(rfc);

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

  // --- SignedInfo ---
  const signedInfoXml = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><Reference URI="#${tsId}"><Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><DigestValue>${tsDigest}</DigestValue></Reference></SignedInfo>`;

  // --- Firma RSA-SHA1 sobre SignedInfo (crypto nativo — compatible con WCF del SAT) ---
  const signer = crypto.createSign('SHA1');
  signer.update(signedInfoXml);
  const signatureB64 = signer.sign(privateKeyPem, 'base64');

  // --- Numero de serie del certificado (decimal) ---
  const cert = new crypto.X509Certificate(
    `-----BEGIN CERTIFICATE-----\n${cerB64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`
  );
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
export async function autenticar(rfc, { onDiag } = {}) {
  const soap = await construirSoapAuth(rfc);
  // Log diagnóstico — el SOAP contiene solo material público (cert + firma)
  if (onDiag) onDiag('SOAP_AUTH_PREVIEW: ' + soap.substring(0, 800).replace(/\n/g, ' '));
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

// ─── Solicitar descarga de CFDI ──────────────────────────────────────────────
export async function solicitarDescarga(rfc, token, fechaInicial, fechaFinal, tipo = 'CFDI') {
  const rfcSolicitante = rfc.toUpperCase();
  // Para recibidos: RfcReceptor = nuestro RFC; TipoSolicitud = formato de descarga (CFDI = XML completo)
  // El tipo de flujo (Recibidos vs Emitidos) lo determina el elemento SOAP, no el atributo TipoSolicitud

  const soap = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Header>
    <o:Security xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <o:BinarySecurityToken ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd#SAML" EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${token}</o:BinarySecurityToken>
    </o:Security>
  </s:Header>
  <s:Body>
    <SolicitaDescargaRecibidos xmlns="http://DescargaMasivaTerceros.sat.gob.mx">
      <solicitud RfcSolicitante="${rfcSolicitante}" RfcReceptor="${rfcSolicitante}" FechaInicial="${fechaInicial}" FechaFinal="${fechaFinal}" TipoSolicitud="CFDI" TipoComprobante="${tipo}"/>
    </SolicitaDescargaRecibidos>
  </s:Body>
</s:Envelope>`;

  const res = await axios.post(SAT_URL.request, soap, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': '"http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/SolicitaDescargaRecibidos"',
      'Authorization': `WRAP access_token="${token}"`,
    },
    timeout: 30000,
  });

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
