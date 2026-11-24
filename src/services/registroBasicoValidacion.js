// Reglas puras de alta pública, sin BD ni proveedor de correo.
// Separadas para ejecutarse con node --test sin secretos ni servicios.
export class ErrorRegistroBasico extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ErrorRegistroBasico';
    this.code = code;
    this.status = status;
  }
}
const EMAIL_RE = /^[^\s@]{1,100}@[^\s@]{1,190}\.[^\s@]{2,}$/;
// El piloto puede habilitar una sola invitación sin abrir el alta a todos.
export function correoRegistroBasicoPermitido(email,env=process.env){
  const autorizado=env.XABOR_ALTA_BASICO_EMAIL_PERMITIDO;
  if(autorizado===undefined)return true;
  return typeof autorizado==='string'&&EMAIL_RE.test(autorizado.trim())&&typeof email==='string'&&
    email.trim().toLowerCase()===autorizado.trim().toLowerCase();
}
const texto = (valor, max) => typeof valor === 'string' ? valor.trim().slice(0, max + 1) : '';
export function validarRegistroBasico(body = {}) {
  const nombreNegocio = texto(body.nombreNegocio, 100);
  const nombrePropietario = texto(body.nombrePropietario, 100);
  const email = texto(body.email, 320).toLowerCase();
  const ciudad = texto(body.ciudad || '', 100);
  const telefono = texto(body.telefono || '', 25);
  const password = body.password;
  if (nombreNegocio.length < 2 || nombreNegocio.length > 100 ||
      nombrePropietario.length < 2 || nombrePropietario.length > 100) {
    throw new ErrorRegistroBasico('DATOS_INVALIDOS', 'Escribe el nombre del negocio y del propietario (2 a 100 caracteres)');
  }
  if (email.length > 320 || !EMAIL_RE.test(email)) {
    throw new ErrorRegistroBasico('EMAIL_INVALIDO', 'Escribe un correo válido');
  }
  if (ciudad.length > 100 || telefono.length > 25 ||
      (telefono && telefono.replace(/\D/g, '').length < 10)) {
    throw new ErrorRegistroBasico('CONTACTO_INVALIDO', 'Revisa los datos de contacto');
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new ErrorRegistroBasico('PASSWORD_INVALIDA', 'La contraseña debe tener de 10 a 128 caracteres');
  }
  if (password.toLowerCase() === email) {
    throw new ErrorRegistroBasico('PASSWORD_INVALIDA', 'Usa una contraseña distinta a tu correo');
  }
  if (body.aceptaAvisoPrivacidad !== true) {
    throw new ErrorRegistroBasico('PRIVACIDAD_REQUERIDA', 'Debes aceptar el aviso de privacidad');
  }
  return { nombreNegocio, nombrePropietario, email, telefono, ciudad, password };
}
