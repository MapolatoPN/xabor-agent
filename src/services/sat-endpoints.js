/**
 * sat-endpoints.js — Endpoints oficiales SAT, Descarga Masiva de CFDI
 *
 * Fuente: SAT — "Consulta y recuperación de comprobantes — URLs del Web Service"
 * WSDL verificados el 2026-07-27 directamente desde México:
 *   auth    → WSDL responde ✅
 *   request → WSDL responde ✅ (confirmado por SAT)
 *   verify  → WSDL responde ✅
 *   download→ URL confirmada por phpcfdi y nodecfdi (WCF no expone WSDL vía GET)
 *
 * Todos los servicios usan subdominio propio bajo clouda.sat.gob.mx.
 * El anterior hostname cfdidescargamasivarfc.sat.gob.mx fue descomisionado.
 *
 * Para actualizar endpoints: modificar ÚNICAMENTE este archivo.
 */

export const SAT_ENDPOINTS = {
  /** Autenticación — obtiene el token Bearer firmado con e.firma */
  auth:     'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/Autenticacion/Autenticacion.svc',

  /** Solicitud de descarga — registra el rango/filtro y devuelve un IdSolicitud */
  request:  'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/SolicitaDescargaService.svc',

  /** Verificación — consulta estado de la solicitud y lista de paquetes listos */
  verify:   'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/VerificaSolicitudDescargaService.svc',

  /** Descarga — descarga el ZIP con los XMLs de cada paquete */
  download: 'https://cfdidescargamasiva.clouda.sat.gob.mx/DescargaMasivaService.svc',
};

/**
 * Namespaces SOAP extraídos directamente de los WSDLs verificados.
 * autenticacion usa un namespace diferente (gob.mx en lugar de sat.gob.mx).
 */
export const SAT_NS = {
  autenticacion: 'http://DescargaMasivaTerceros.gob.mx',
  descarga:      'http://DescargaMasivaTerceros.sat.gob.mx',
};

/**
 * SOAPActions por operación, extraídas de los WSDLs.
 */
export const SAT_ACTIONS = {
  autentica:              'http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica',
  solicitaEmitidos:       'http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/SolicitaDescargaEmitidos',
  solicitaRecibidos:      'http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/SolicitaDescargaRecibidos',
  solicitaFolio:          'http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/SolicitaDescargaFolio',
  verificaSolicitud:      'http://DescargaMasivaTerceros.sat.gob.mx/IVerificaSolicitudDescargaService/VerificaSolicitudDescarga',
};
