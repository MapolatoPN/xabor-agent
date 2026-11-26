import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { crearTokenTicket, verificarTokenTicket, enlacePublicoTicket, enlaceWhatsAppTicket, correoTicketValido, claveEnvioTicket } from '../src/services/ticketVentaEnlaces.js';
import { ticketVentaHtml } from '../src/services/ticketVentaBasico.js';
const env={SESSION_SECRET:'solo-local-ticket-secreto-largo-2026',PUBLIC_URL:'https://xabor.mx',NODE_ENV:'production'};
const negocioId=randomUUID(),folio='RM-ABC-1',ahora=Date.now();
const token=crearTokenTicket({negocioId,folio},{env,ahora}).token;
test('el permiso firmado abarca un ticket, vence a los 30 días y falla cerrado',()=>{
  const d=verificarTokenTicket(token,{env,ahora}); assert.equal(d.negocioId,negocioId);assert.equal(d.folio,folio);
  assert.equal(d.exp-d.iat,30*86400);
  for(const valor of ['',null,token+'x','x'.repeat(2000),token.replace(/.$/,'!')]) assert.equal(verificarTokenTicket(valor,{env,ahora}),null);
  assert.equal(verificarTokenTicket(token,{env:{...env,SESSION_SECRET:'otro-secreto-de-ticket-2026'},ahora}),null);
  assert.equal(verificarTokenTicket(token,{env,ahora:ahora+30*86400000}),null);
  assert.equal(verificarTokenTicket(token,{env,ahora:ahora-120000}),null);
  assert.equal(verificarTokenTicket(token,{env:{},ahora}),null);
  assert.throws(()=>crearTokenTicket({negocioId,folio},{env:{}}));
  const [texto]=token.split('.');
  const alterado=Buffer.from(JSON.stringify({...d,folio:'OTRO'})).toString('base64url');
  assert.equal(verificarTokenTicket(alterado+'.'+token.split('.')[1],{env,ahora}),null);
  const sigNoCanonica=token.slice(0,-1)+'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.at(('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(token.at(-1))|1));
  assert.equal(verificarTokenTicket(sigNoCanonica,{env,ahora}),null);
  const extendido=Buffer.from(JSON.stringify({...d,exp:d.iat+31*86400})).toString('base64url');
  const firmar=s=>createHmac('sha256',env.SESSION_SECRET).update('xabor:ticket-venta:v1\n'+s).digest('base64url');
  assert.equal(verificarTokenTicket(extendido+'.'+firmar(extendido),{env,ahora}),null);
  assert(texto);assert.throws(()=>crearTokenTicket({negocioId,folio:'mal\nfolio'},{env}));
});
test('los enlaces y la deduplicación usan el origen y ámbito del servidor',()=>{
  const enlace=enlacePublicoTicket(token,{...env,PUBLIC_URL:'https://xabor.mx/ignorado?otro=1'});
  assert.equal(new URL(enlace).origin,'https://xabor.mx');assert(!enlace.includes('?'));
  for(const PUBLIC_URL of ['http://evil.test','https://u:clave@evil.test','javascript:alert(1)']) assert.throws(()=>enlacePublicoTicket(token,{...env,PUBLIC_URL}));
  const wa=new URL(enlaceWhatsAppTicket({negocio:'Café & Pan',folio,enlace}));
  assert.equal(wa.origin,'https://wa.me');assert.equal(wa.searchParams.get('text'),`Tu ticket de Café & Pan\nFolio: ${folio}\n${enlace}`);
  for(const email of ['a@b.test','hola+ticket@ejemplo.mx'])assert(correoTicketValido(email));
  for(const email of ['','a@b','a@b.test,b@c.test','a\r\n@b.test','Nombre <a@b.test>'])assert(!correoTicketValido(email));
  const args={negocioId,folio,email:'cliente@ejemplo.invalid',solicitudId:randomUUID(),token};
  const key=claveEnvioTicket(args,env);assert.equal(key,claveEnvioTicket(args,env));assert(!key.includes(args.email));
  for(const campo of ['negocioId','folio','email','solicitudId','token']) assert.notEqual(key,claveEnvioTicket({...args,[campo]:'otro'},env));
});
test('el ticket público no incluye datos de contacto ni los controles de envío y conserva el total',()=>{
  const args={negocio:'<Café>',folio,estado:'entregado',fecha:new Date(),datos:{items:[{producto:'Pan <x>',cantidad:2,precio:25}],total:45,descuento:5,forma_pago:'efectivo',telefono:'PRIVADO',direccion:'PRIVADA',nombre_cliente:'PERSONA PRIVADA'}};
  const html=ticketVentaHtml(args);assert(html.includes('$45.00'));assert(html.includes('Pan &lt;x&gt;'));
  for(const privado of ['PRIVADO','PRIVADA','ticket-correo','ticket-whatsapp','<Café>']) assert(!html.includes(privado));
  assert(html.includes('No es una factura fiscal'));
  const privado=ticketVentaHtml({...args,entrega:{token,negocioId,whatsappUrl:'https://wa.me/?text=hola',correoDisponible:true}});
  assert(privado.includes('ticket-correo'));assert(privado.includes('30 días'));
  const script=readFileSync(new URL('../public/ticket-venta.js',import.meta.url));
  const hash=createHash('sha256').update(script.toString().replace(/\r\n/g,'\n')).digest('hex').slice(0,8);
  assert(html.includes('/public/ticket-venta.js?v='+hash),'La huella invalida la caché al cambiar el código');
});
function interfaz(fetch){
  const nodos=new Map();
  for(const id of ['ticket-imprimir','ticket-correo','ticket-email','ticket-enviar','ticket-mensaje'])nodos.set(id,{value:'Cliente@Ejemplo.invalid',disabled:false,textContent:'',dataset:{endpoint:'/api/tickets-venta/F/correo',token:'FIRMA',negocio:'NEGOCIO'},handlers:{},classList:{add(){},remove(){}},addEventListener(e,fn){this.handlers[e]=fn;},reportValidity:()=>true});
  let impresiones=0;
  vm.runInNewContext(readFileSync(new URL('../public/ticket-venta.js',import.meta.url),'utf8'),{document:{getElementById:id=>nodos.get(id)},window:{print(){impresiones++;}},crypto:{randomUUID},AbortSignal,fetch});
  return {nodos,submit:()=>nodos.get('ticket-correo').handlers.submit({preventDefault(){}}),impresiones:()=>impresiones};
}
test('interfaz: bloquea dobles clics, conserva la solicitud al reintentar y permite otro destinatario',async()=>{
  const peticiones=[];let terminar;
  const i=interfaz(async(url,op)=>{peticiones.push({url,...op});return new Promise(r=>terminar=r);});
  i.nodos.get('ticket-imprimir').handlers.click();assert.equal(i.impresiones(),1);
  const p=i.submit();await i.submit();assert.equal(peticiones.length,1);assert(i.nodos.get('ticket-enviar').disabled);
  terminar({ok:false,json:async()=>({error:'Proveedor temporalmente no disponible'})});await p;
  assert(!i.nodos.get('ticket-enviar').disabled);
  const q=i.submit();assert.deepEqual(JSON.parse(peticiones[1].body),JSON.parse(peticiones[0].body));
  terminar({ok:true,json:async()=>({enviado:true})});await q;await i.submit();assert.equal(peticiones.length,2);
  assert(i.nodos.get('ticket-mensaje').textContent.includes('Correo enviado'));
  const e=i.nodos.get('ticket-email');e.value='otro@ejemplo.invalid';e.handlers.input();assert(!i.nodos.get('ticket-enviar').disabled);
  const s=i.submit();assert.notEqual(JSON.parse(peticiones[2].body).solicitudId,JSON.parse(peticiones[1].body).solicitudId);
  terminar({ok:true,json:async()=>({enviado:true})});await s;
});
test('interfaz: una pérdida de red muestra incertidumbre, nunca éxito',async()=>{
  const i=interfaz(async()=>{throw new TypeError('red');});await i.submit();
  assert(i.nodos.get('ticket-mensaje').textContent.startsWith('No se confirmó'));
  assert(!i.nodos.get('ticket-enviar').disabled);
});
test('sin proveedor o fuera de producción el correo falla cerrado y no usa la red',async()=>{
  const original=process.env.NODE_ENV;
  try{
    process.env.NODE_ENV='development';
    const {enviarCorreoTicketVenta,correoTicketDisponible}=await import('../src/services/email.js');
    assert.equal(correoTicketDisponible(),false);
    assert.deepEqual(await enviarCorreoTicketVenta({to:'nadie@ejemplo.invalid'}),{enviado:false,motivo:'proveedor_no_disponible'});
  }finally{if(original===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=original;}
});
