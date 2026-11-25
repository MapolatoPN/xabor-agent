import test from 'node:test';
import assert from 'node:assert/strict';
import { validarRegistroBasico, ErrorRegistroBasico,correoRegistroBasicoPermitido,registroBasicoPorInvitacion } from '../src/services/registroBasicoValidacion.js';
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
test('el piloto de registro admite solo el correo invitado y normaliza mayúsculas',()=>{
 const env={XABOR_ALTA_BASICO_EMAIL_PERMITIDO:'  PILOTO@EJEMPLO.INVALID  '};
 assert.equal(correoRegistroBasicoPermitido('piloto@ejemplo.invalid',env),true);
 assert.equal(correoRegistroBasicoPermitido('otra@ejemplo.invalid',env),false);
 assert.equal(correoRegistroBasicoPermitido(undefined,env),false);
 assert.equal(correoRegistroBasicoPermitido('otra@ejemplo.invalid',{}),true);
});
test('una invitación vacía o mal configurada no abre el registro general',()=>{
 for(const autorizado of ['', '*', 'dominio.invalid', null])assert.equal(correoRegistroBasicoPermitido('piloto@ejemplo.invalid',{XABOR_ALTA_BASICO_EMAIL_PERMITIDO:autorizado}),false);
});
test('apertura pública explícita admite clientes y conserva el modo de invitación para reversión',()=>{
 const base={XABOR_ALTA_BASICO_EMAIL_PERMITIDO:'piloto@ejemplo.invalid'};
 const abierto={...base,XABOR_ALTA_BASICO_MODO:'publico'};
 assert.equal(correoRegistroBasicoPermitido('cliente@ejemplo.invalid',abierto),true);
 assert.equal(correoRegistroBasicoPermitido('incorrecto',abierto),false);
 assert.equal(registroBasicoPorInvitacion(abierto),false);
 assert.equal(registroBasicoPorInvitacion(base),true);
 assert.equal(correoRegistroBasicoPermitido('cliente@ejemplo.invalid',{...base,XABOR_ALTA_BASICO_MODO:'invitacion'}),false);
 for(const modo of ['',null,'public','PUBLICO'])assert.equal(correoRegistroBasicoPermitido('cliente@ejemplo.invalid',{...base,XABOR_ALTA_BASICO_MODO:modo}),false);
 assert.equal(correoRegistroBasicoPermitido('cliente@ejemplo.invalid',{XABOR_ALTA_BASICO_MODO:'invitacion'}),false);
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

test('ambas pantallas públicas tienen JavaScript sintácticamente válido',()=>{
  for (const nombre of ['registro-basico.html','activar-basico.html']) {
    const html=readFileSync(new URL('../panel/'+nombre,import.meta.url),'utf8');
    const script=html.match(/<script type="module">([\s\S]*?)<\/script>/);
    assert.ok(script,'Falta script público en '+nombre);
    assert.doesNotThrow(()=>new Function(script[1]),nombre);
  }
});
