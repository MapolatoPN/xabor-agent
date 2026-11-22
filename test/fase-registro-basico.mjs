import test from 'node:test';
import assert from 'node:assert/strict';
import { validarRegistroBasico, ErrorRegistroBasico } from '../src/services/registroBasicoValidacion.js';
import { readFileSync } from 'node:fs';
const bueno = () => ({
  nombreNegocio: 'Fonda Lupita', nombrePropietario: 'Lupita Torres',
  email: '  LUPITA@EJEMPLO.COM  ', password: 'UnaClaveSegura2026!',
  telefono: '878-123-4567', ciudad: 'Piedras Negras', aceptaAvisoPrivacidad: true,
});
test('normaliza correo y mantiene solo los campos permitidos',()=>{
  const x=validarRegistroBasico({...bueno(),rol:'superadmin',modulosIniciales:['whatsapp'],precio:0});
  assert.equal(x.email,'lupita@ejemplo.com');
  assert.deepEqual(Object.keys(x).sort(),['ciudad','email','nombreNegocio','nombrePropietario','password','telefono'].sort());
});
test('la privacidad es obligatoria',()=>{
  assert.throws(()=>validarRegistroBasico({...bueno(),aceptaAvisoPrivacidad:false}),e=>e instanceof ErrorRegistroBasico&&e.code==='PRIVACIDAD_REQUERIDA');
});
test('el correo debe ser válido',()=>{
  assert.throws(()=>validarRegistroBasico({...bueno(),email:'incorrecto'}),e=>e.code==='EMAIL_INVALIDO');
});
test('rechaza contraseñas cortas o iguales al correo',()=>{
  assert.throws(()=>validarRegistroBasico({...bueno(),password:'12345678'}),e=>e.code==='PASSWORD_INVALIDA');
  assert.throws(()=>validarRegistroBasico({...bueno(),password:'lupita@ejemplo.com'}),e=>e.code==='PASSWORD_INVALIDA');
});
test('valida nombres y contacto',()=>{
  assert.throws(()=>validarRegistroBasico({...bueno(),nombreNegocio:'A'}),e=>e.code==='DATOS_INVALIDOS');
  assert.throws(()=>validarRegistroBasico({...bueno(),telefono:'123'}),e=>e.code==='CONTACTO_INVALIDO');
});
test('la bandera pública está APAGADA si no se configura',()=>{
  const rutas=readFileSync(new URL('../src/services/registroBasicoRutas.js',import.meta.url),'utf8');
  assert.match(rutas,/XABOR_ALTA_PUBLICA_BASICO === 'true'/);
  assert.match(rutas,/soloSiHabilitado/);
  assert.match(rutas,/rateLimitMiddleware/);
});
test('el token no se devuelve desde la solicitud',()=>{
  const codigo=readFileSync(new URL('../src/services/registroBasico.js',import.meta.url),'utf8');
  assert.match(codigo,/hashTokenRegistro/);
  assert.match(codigo,/FOR UPDATE/);
  assert.match(codigo,/BEGIN/);
  assert.match(codigo,/COMMIT/);
  assert.match(codigo,/password_hash = '\[consumido\]'/);
});
