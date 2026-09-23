// Autofactura nativa — fase 3: validación de los datos fiscales que el
// cliente captura en el portal público. Pura (sin base, sin red): recibe el
// cuerpo tal cual llegó y devuelve o bien los datos NORMALIZADOS que se van a
// mostrar en la confirmación, o bien un error por campo. No persiste nada.
//
// Qué se normaliza y qué NO:
//   - RFC: mayúsculas y sin espacios/guiones (normalizarRFC, la misma regla
//     de la libreta fiscal); 12 caracteres = persona moral, 13 = física.
//   - Nombre / razón social: SOLO se recorta. No se corrige, no se pone en
//     mayúsculas, no se quita "S.A. de C.V.": debe coincidir con la Constancia
//     de Situación Fiscal y eso lo decide el cliente, no Xabor.
//   - CP: exactamente 5 dígitos, tal cual.
//   - Régimen y uso de CFDI: deben existir en el catálogo SAT del backend y
//     aplicar al tipo de persona del RFC. La compatibilidad fina régimen<->uso
//     NO se valida aquí (no está en el repo): la decide Facturapi al timbrar.
//   - Correo: recortado y en minúsculas; obligatorio en V1.
//   - RFC genérico (XAXX010101000 / XEXX010101000): rechazado a propósito.
import { normalizarRFC } from './database.js';
import { buscarRegimen, buscarUsoCfdi, usoCompatibleConRegimen } from './catalogosSat.js';

const RFC_FORMATO = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const RFC_GENERICOS = new Set(['XAXX010101000', 'XEXX010101000']);
const EMAIL_FORMATO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOMBRE_MAX = 254;
const EMAIL_MAX = 254;
const ENTRADA_MAX = 300;

export const AVISO_NOMBRE = 'Debe coincidir exactamente con tu Constancia de Situación Fiscal.';

const texto = (v) => (typeof v === 'string' && v.length <= ENTRADA_MAX ? v.trim() : null);

/**
 * @returns {{ ok: true, datos: object } | { ok: false, errores: Record<string, string> }}
 */
export function validarDatosFiscales(entrada) {
  const b = entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
  const errores = {};

  // RFC
  const rfcCrudo = texto(b.rfc);
  const rfc = rfcCrudo === null ? '' : normalizarRFC(rfcCrudo);
  let tipoPersona = null;
  if (!rfc) errores.rfc = 'Captura tu RFC.';
  else if (!RFC_FORMATO.test(rfc)) errores.rfc = 'El RFC no tiene un formato válido (12 caracteres para persona moral, 13 para persona física).';
  else if (RFC_GENERICOS.has(rfc)) errores.rfc = 'La autofacturación nominativa no admite RFC genérico por el momento.';
  else tipoPersona = rfc.length === 12 ? 'moral' : 'fisica';

  // Nombre / razón social: se recorta, nunca se corrige.
  const nombre = texto(b.nombre) ?? texto(b.razon_social) ?? texto(b.nombre_fiscal);
  if (!nombre) errores.nombre = 'Captura tu nombre o razón social.';
  else if (nombre.length < 3) errores.nombre = 'El nombre es demasiado corto.';
  else if (nombre.length > NOMBRE_MAX) errores.nombre = `El nombre no puede exceder ${NOMBRE_MAX} caracteres.`;
  else if (/[\u0000-\u001f\u007f]/.test(nombre)) errores.nombre = 'El nombre contiene caracteres no permitidos.';

  // CP fiscal
  const cp = texto(b.cp) ?? texto(b.codigo_postal);
  if (!cp) errores.cp = 'Captura tu código postal fiscal.';
  else if (!/^[0-9]{5}$/.test(cp)) errores.cp = 'El código postal debe tener exactamente 5 dígitos.';

  // Régimen fiscal (catálogo del backend, aplicable al tipo de persona)
  const regimen = buscarRegimen(texto(b.regimen) ?? texto(b.regimen_fiscal));
  if (!regimen) errores.regimen = 'Selecciona un régimen fiscal del catálogo.';
  else if (tipoPersona === 'moral' && !regimen.moral) errores.regimen = 'Ese régimen no aplica a personas morales.';
  else if (tipoPersona === 'fisica' && !regimen.fisica) errores.regimen = 'Ese régimen no aplica a personas físicas.';

  // Uso de CFDI (catálogo del backend, aplicable al tipo de persona)
  const uso = buscarUsoCfdi(texto(b.uso_cfdi) ?? texto(b.uso));
  if (!uso) errores.uso_cfdi = 'Selecciona un uso de CFDI del catálogo.';
  else if (tipoPersona === 'moral' && !uso.moral) errores.uso_cfdi = 'Ese uso de CFDI no aplica a personas morales.';
  else if (tipoPersona === 'fisica' && !uso.fisica) errores.uso_cfdi = 'Ese uso de CFDI no aplica a personas físicas.';
  else if (regimen && !errores.regimen && !usoCompatibleConRegimen(uso.clave, regimen.clave)) {
    errores.uso_cfdi = 'Este uso de CFDI no es compatible con el régimen fiscal seleccionado.';
  }

  // Correo (obligatorio en V1)
  const emailCrudo = texto(b.email) ?? texto(b.correo);
  const email = emailCrudo ? emailCrudo.toLowerCase() : '';
  if (!email) errores.email = 'Captura tu correo electrónico.';
  else if (email.length > EMAIL_MAX || !EMAIL_FORMATO.test(email)) errores.email = 'El correo electrónico no es válido.';

  if (Object.keys(errores).length) return { ok: false, errores };
  return {
    ok: true,
    datos: {
      rfc, tipo_persona: tipoPersona, nombre, cp,
      regimen: regimen.clave, regimen_nombre: regimen.nombre,
      uso_cfdi: uso.clave, uso_nombre: uso.nombre,
      email,
    },
  };
}
