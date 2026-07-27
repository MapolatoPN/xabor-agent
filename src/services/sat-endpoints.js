/**
 * sat-endpoints.js — Endpoints oficiales SAT, Descarga Masiva de Documentos Digitales
 *
 * Fuente: SAT — "Consulta y recuperación de comprobantes — URLs del Web Service"
 * Dominio vigente: clouda.sat.gob.mx  (el anterior cfdidescargamasivarfc.sat.gob.mx fue descomisionado)
 *
 * Para actualizar endpoints en el futuro: modificar ÚNICAMENTE este archivo.
 * No dispersar URLs del SAT en otros módulos.
 */

export const SAT_ENDPOINTS = {
  auth:     'https://clouda.sat.gob.mx/Autenticacion/Autenticacion/1.0.0/autenticacion',
  request:  'https://clouda.sat.gob.mx/Descarga/SolicitudDescarga/1.0.0/SolicitudDescargaMasivaTercerosMTCC',
  verify:   'https://clouda.sat.gob.mx/Descarga/VerificaSolicitudDescarga/1.0.0/VerificaSolicitudDescargaMTCC',
  download: 'https://clouda.sat.gob.mx/Descarga/DescargaMasiva/1.0.0/DescargaMasiva',
};

/**
 * Namespaces SOAP — no cambian con el nuevo dominio (forman parte del WSDL).
 */
export const SAT_NS = {
  autenticacion: 'http://DescargaMasivaTerceros.gob.mx',
  descarga:      'http://DescargaMasivaTerceros.sat.gob.mx',
};
