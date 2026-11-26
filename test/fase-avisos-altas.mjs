import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
const originales={NODE_ENV:process.env.NODE_ENV,RESEND_API_KEY:process.env.RESEND_API_KEY,LEADS_NOTIFICATION_EMAIL:process.env.LEADS_NOTIFICATION_EMAIL,PUBLIC_URL:process.env.PUBLIC_URL};
const fetchOriginal=globalThis.fetch,peticiones=[];
let correo,modo='ok';
before(async()=>{
  Object.assign(process.env,{NODE_ENV:'production',RESEND_API_KEY:'QA_SIN_CREDENCIAL_REAL',LEADS_NOTIFICATION_EMAIL:'avisos@ejemplo.invalid',PUBLIC_URL:'https://qa.xabor.invalid'});
  globalThis.fetch=async(url,op)=>{
    assert.equal(url,'https://api.resend.com/emails');peticiones.push({body:JSON.parse(op.body),headers:op.headers});
    if(modo==='red')throw new TypeError('Proveedor local no disponible');
    return new Response(JSON.stringify(modo==='sin-id'?{}:{id:'QA_CORREO_ACEPTADO'}),{status:modo==='rechazo'?503:200,headers:{'Content-Type':'application/json'}});
  };
  correo=await import('../src/services/email.js?qa-avisos-altas');
});
after(()=>{globalThis.fetch=fetchOriginal;for(const[k,v]of Object.entries(originales)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
const alta={solicitudId:'QA_SOLICITUD',negocio:'Café <local>',propietario:'Persona QA',email:'cliente@ejemplo.invalid',ciudad:'Ciudad QA',telefono:'5511111111'};
const prospecto={id:'QA_PROSPECTO',nombre:'Persona QA',negocio:'Negocio QA\r\n',ciudad:'Ciudad QA',telefono:'5511111111',tipoNegocio:'Restaurante',createdAt:'2026-11-26T12:00:00Z'};
test('alta verificada: aviso al dueño configurado, contenido escapado y sin secretos del registro',async()=>{
  assert.equal((await correo.enviarNotificacionAltaBasico({...alta,password_hash:'NO_PUBLICAR',token:'NO_PUBLICAR',token_hash:'NO_PUBLICAR'})).enviado,true);
  const p=peticiones.at(-1);assert.deepEqual(p.body.to,['avisos@ejemplo.invalid']);
  assert(p.body.html.includes('Café &lt;local&gt;'));assert(p.body.html.includes(alta.email));assert(p.body.html.includes('https://qa.xabor.invalid/superadmin'));
  assert(!p.body.html.includes('NO_PUBLICAR'));assert(!p.body.html.includes('activar-basico'));
  assert.equal(p.headers['Idempotency-Key'],'alta-basico/QA_SOLICITUD');assert(!p.body.html.includes('pago aprobado'));
});
test('prospectos Pro: mismo destinatario y clave estable al reintentar',async()=>{
  for(let n=0;n<2;n++)assert.equal((await correo.enviarNotificacionNuevoProspecto(prospecto)).enviado,true);
  const [a,b]=peticiones.slice(-2);assert.deepEqual(a,b);assert.equal(a.headers['Idempotency-Key'],'prospecto/QA_PROSPECTO');
  assert.deepEqual(a.body.to,['avisos@ejemplo.invalid']);assert(!/[\r\n]/.test(a.body.subject));
});
test('rechazo, pérdida de red o respuesta sin ID nunca se presentan como aviso enviado',async()=>{
  for(modo of ['rechazo','red','sin-id']){
    assert.equal((await correo.enviarNotificacionAltaBasico(alta)).enviado,false);
    assert.equal((await correo.enviarNotificacionNuevoProspecto(prospecto)).enviado,false);
  }
  modo='ok';
});
test('fuera de producción y sin clave de correo no se utiliza la red',async()=>{
  const antes=peticiones.length;process.env.NODE_ENV='development';
  assert.equal((await correo.enviarNotificacionAltaBasico(alta)).enviado,false);
  assert.equal((await correo.enviarNotificacionNuevoProspecto(prospecto)).enviado,false);
  process.env.NODE_ENV='production';delete process.env.RESEND_API_KEY;
  const sinClave=await import('../src/services/email.js?qa-avisos-sin-clave');
  assert.equal((await sinClave.enviarNotificacionAltaBasico(alta)).enviado,false);
  assert.equal(peticiones.length,antes);process.env.RESEND_API_KEY='QA_SIN_CREDENCIAL_REAL';
});
