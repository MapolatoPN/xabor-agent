import './entorno-superadmin-local.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/services/database.js';
import { crearTokenSesion } from '../src/services/session.js';
import { crearTokenTicket } from '../src/services/ticketVentaEnlaces.js';
import { arrancarServidor } from './lib-servidor.mjs';
import { huellaClave } from '../src/services/limitesPersistentes.js';
let srv,proveedor,a,b,staff,mesero,sinPos,token;
const folio='QA-TK-'+randomUUID().slice(0,8),intentos=[],enviados=new Map();
let modo='ok';
async function negocio(pos=true){
  const {rows:[n]}=await pool.query(`INSERT INTO negocios(nombre,slug,activo,estado) VALUES ('Café QA & Pan',$1,true,'activo') RETURNING id`,['qa-ticket-'+randomUUID()]);
  if(pos)await pool.query(`INSERT INTO negocio_modulos(negocio_id,modulo,estado) VALUES($1,'pos','activo')`,[n.id]);
  return n.id;
}
async function usuario(nid,rol='admin'){
  const {rows:[u]}=await pool.query(`INSERT INTO usuarios(negocio_id,nombre,email,activo) VALUES($1,'Persona QA',$2,true) RETURNING id`,[nid,randomUUID()+'@ejemplo.invalid']);
  await pool.query(`INSERT INTO usuario_negocios(usuario_id,negocio_id,rol,activo) VALUES($1,$2,$3,true)`,[u.id,nid,rol]);
  return {nid,uid:u.id,cookie:'xabor_sesion='+encodeURIComponent(crearTokenSesion({usuarioId:u.id,negocioId:nid,rol}))};
}
async function pedir(path,{cuenta=a,method='GET',body,headers={}}={}){
  const r=await fetch(srv.base+path,{method,headers:{...(cuenta?{Cookie:cuenta.cookie}:{}),'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined,redirect:'manual'});
  const texto=await r.text();let data;try{data=JSON.parse(texto);}catch{data=texto;}
  return {status:r.status,data,headers:r.headers};
}
const enviar=(op={})=>pedir('/api/tickets-venta/'+folio+'/correo',{method:'POST',body:{email:'cliente@ejemplo.invalid',solicitudId:randomUUID(),token,...op.body},...op,headers:{'X-Xabor-Accion':'enviar-ticket',Origin:'https://qa.xabor.invalid',...op.headers}});
before(async()=>{
  a=await usuario(await negocio());b=await usuario(await negocio());staff=await usuario(a.nid,'staff');mesero=await usuario(a.nid,'mesero');sinPos=await usuario(await negocio(false));
  await pool.query(`INSERT INTO pedidos_activos(negocio_id,folio,estado,datos) VALUES($1,$2,'nuevo',$3)`,[a.nid,folio,{items:[{nombre:'Pan de la casa',cantidad:2,precio_unitario:25}],total:45,descuento:5,forma_pago:'efectivo',telefono:'CONTACTO_PRIVADO',direccion:'DOMICILIO_PRIVADO'}]);
  await pool.query(`INSERT INTO pedidos_activos(negocio_id,folio,estado,datos) VALUES($1,$2,'nuevo',$3)`,[b.nid,folio+'B',{total:9999,items:[{nombre:'PRODUCTO_AJENO',cantidad:1,precio:9999}]}]);
  token=crearTokenTicket({negocioId:a.nid,folio}).token;
  proveedor=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    if(req.url!=='/api.resend.com/emails'){res.writeHead(404);return res.end('{}');}
    const body=JSON.parse(raw),key=req.headers['idempotency-key'];intentos.push({body,key});
    if(modo==='error'){res.writeHead(503);return res.end('{}');}
    if(modo==='sin-id'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{}');}
    if(!enviados.has(key))enviados.set(key,{id:randomUUID(),body});
    else assert.deepEqual(body,enviados.get(key).body,'Un reintento conserva exactamente el contenido');
    if(modo==='respuesta-perdida'){res.destroy();return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:enviados.get(key).id}));
  });
  await new Promise(r=>proveedor.listen(0,'127.0.0.1',r));
  srv=await arrancarServidor({PORT:'4946',NODE_ENV:'production',PUBLIC_URL:'https://qa.xabor.invalid',RESEND_API_KEY:'QA_RESEND_SIN_VALOR_REAL',META_APP_SECRET:'QA_META_SIN_VALOR_REAL',
    XABOR_BASICO_QA:'SI',XABOR_QA_PROVEEDORES_URL:'http://127.0.0.1:'+proveedor.address().port,
    XABOR_ACCESO_LEGADO:'denegar',NODE_OPTIONS:process.env.NODE_OPTIONS+' --import=./test/basico-proveedores-locales.mjs'});
});
after(async()=>{srv?.detener();if(proveedor?.listening)await new Promise(r=>proveedor.close(r));await pool.end();});
test('ticket privado ofrece ambas opciones, mantiene total y exige sesión/negocio/POS',async()=>{
  const r=await pedir('/ticket-venta/'+folio);assert.equal(r.status,200);assert(r.data.includes('$45.00'));assert(r.data.includes('Compartir por WhatsApp'));assert(r.data.includes('Enviar por correo'));
  assert.equal((await pedir('/ticket-venta/'+folio,{cuenta:null})).status,401);
  assert.equal((await pedir('/ticket-venta/'+folio,{cuenta:b})).status,404);
  assert.equal((await pedir('/ticket-venta/'+folio,{cuenta:sinPos})).status,403);
  assert.equal((await pedir('/ticket-venta/NO-EXISTE')).status,404);
  assert.equal(r.headers.get('cache-control'),'private, no-store');
});
test('enlace público: sin sesión, aislado de otras ventas, sin contacto ni funciones de negocio',async()=>{
  const r=await pedir('/ticket-compartido/'+token,{cuenta:null});assert.equal(r.status,200);assert(r.data.includes('$45.00'));
  for(const dato of ['PRODUCTO_AJENO','CONTACTO_PRIVADO','DOMICILIO_PRIVADO','ticket-correo','ticket-whatsapp'])assert(!r.data.includes(dato));
  assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.equal(r.headers.get('cache-control'),'private, no-store');
  assert(r.headers.get('x-robots-tag').includes('noindex'));assert(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  for(const invalido of ['x',token+'x',crearTokenTicket({negocioId:a.nid,folio},{ahora:Date.now()-31*86400000}).token])assert.equal((await pedir('/ticket-compartido/'+invalido,{cuenta:null})).status,404);
});
test('correo: autentica, verifica permisos, firma y origen antes de llamar al proveedor',async()=>{
  const antes=intentos.length;
  for(const cuenta of [null,mesero,sinPos]) assert([401,403].includes((await enviar({cuenta})).status));
  assert.equal((await enviar({cuenta:b})).status,403);
  assert.equal((await enviar({headers:{'X-Xabor-Accion':'otra'}})).status,403);
  assert.equal((await enviar({headers:{Origin:'https://ajeno.invalid'}})).status,403);
  assert.equal((await enviar({headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  for(const body of [{token:'invalido'},{token:crearTokenTicket({negocioId:a.nid,folio:'OTRO'}).token}])assert.equal((await enviar({body:{email:'cliente@ejemplo.invalid',solicitudId:randomUUID(),...body}})).status,403);
  for(const email of ['a@b','a@b.test,b@c.test','a\r\n@b.test'])assert.equal((await enviar({body:{email,solicitudId:randomUUID(),token}})).status,400);
  assert.equal(intentos.length,antes);
  const grande=await enviar({body:{email:'cliente@ejemplo.invalid',solicitudId:randomUUID(),token,extra:'x'.repeat(5000)}});
  assert.equal(grande.status,413);assert.equal(intentos.length,antes);
});
test('correo real HTTP a proveedor local: datos calculados en servidor y reintento idempotente',async()=>{
  const body={email:'CLIENTE@EJEMPLO.INVALID',solicitudId:randomUUID(),token,total:1,enlace:'https://evil.invalid',negocioId:b.nid};
  const antes=enviados.size;
  for(let i=0;i<2;i++)assert.equal((await enviar({cuenta:staff,body})).status,200);
  assert.equal(enviados.size,antes+1);
  const {body:correo,key}=intentos.at(-1);assert.deepEqual(correo.to,['cliente@ejemplo.invalid']);assert.match(key,/^ticket\/[a-f0-9]{64}$/);
  assert(correo.html.includes('https://qa.xabor.invalid/ticket-compartido/'));assert(correo.html.includes('Café QA &amp; Pan'));
  assert(!JSON.stringify(correo).includes('evil.invalid'));assert(!JSON.stringify(correo).includes('CONTACTO_PRIVADO'));
});
test('respuesta perdida: primer intento no declara éxito y repetir no envía otro correo',async()=>{
  const body={email:'perdida@ejemplo.invalid',solicitudId:randomUUID(),token},antes=enviados.size;
  modo='respuesta-perdida';assert.equal((await enviar({body})).status,503);
  modo='ok';assert.equal((await enviar({body})).status,200);assert.equal(enviados.size,antes+1);
});
test('respuesta sin ID o rechazo del proveedor nunca se presenta como correo enviado',async()=>{
  for(const valor of ['sin-id','error']){
    modo=valor;const r=await enviar({body:{email:valor+'@ejemplo.invalid',solicitudId:randomUUID(),token}});
    assert.equal(r.status,503);assert.notEqual(r.data.enviado,true);
  }
  modo='ok';
});
test('el límite por destinatario es persistente y guarda solo huellas, sin correo',async()=>{
  // Los dos envíos del caso anterior al mismo destinatario ocupan dos lugares.
  assert.equal((await enviar()).status,200);const antes=intentos.length;
  assert.equal((await enviar()).status,429);assert.equal(intentos.length,antes);
  const {rows}=await pool.query('SELECT clave FROM limites_acceso WHERE vence_at>now()');assert(rows.every(r=>/^[a-f0-9]{64}$/.test(r.clave)));
});
test('los envíos simultáneos respetan el límite compartido sin mandar correos de más',async()=>{
  const antes=intentos.length;
  const rs=await Promise.all(Array.from({length:8},()=>enviar({body:{email:'simultaneo@ejemplo.invalid',solicitudId:randomUUID(),token}})));
  assert.equal(rs.filter(r=>r.status===200).length,3);assert.equal(rs.filter(r=>r.status===429).length,5);assert.equal(intentos.length,antes+3);
});
test('los topes por usuario y por negocio también cierran el envío antes del proveedor',async()=>{
  for(const [clave,limite] of [['ticket-usuario:'+a.uid,30],['ticket-negocio:'+a.nid,300]]){
    const {rows}=await pool.query(`INSERT INTO limites_acceso(clave,vence_at) SELECT $1,now()+INTERVAL '1 day' FROM generate_series(1,$2) RETURNING id`,[huellaClave(clave),limite]);
    try{const antes=intentos.length;assert.equal((await enviar({body:{email:'tope@ejemplo.invalid',solicitudId:randomUUID(),token}})).status,429);assert.equal(intentos.length,antes);}
    finally{await pool.query('DELETE FROM limites_acceso WHERE id=ANY($1::bigint[])',[rows.map(r=>r.id)]);}
  }
});
test('revocar membresía bloquea envíos aun con la sesión anterior',async()=>{
  await pool.query('UPDATE usuario_negocios SET activo=false WHERE usuario_id=$1',[staff.uid]);
  assert.equal((await enviar({cuenta:staff})).status,403);
});
test('archivar y suspender POS no rompen un ticket ya compartido; borrar la venta lo retira',async()=>{
  await pool.query("UPDATE pedidos_activos SET estado='entregado' WHERE negocio_id=$1 AND folio=$2",[a.nid,folio]);
  await pool.query("UPDATE negocio_modulos SET estado='suspendido' WHERE negocio_id=$1 AND modulo='pos'",[a.nid]);
  assert.equal((await pedir('/ticket-compartido/'+token,{cuenta:null})).status,200);
  assert.equal((await enviar()).status,403);
  await pool.query('DELETE FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2',[a.nid,folio]);
  assert.equal((await pedir('/ticket-compartido/'+token,{cuenta:null})).status,404);
  assert.equal((await pedir('/ticket-venta/'+folio+'B',{cuenta:b})).status,200);
});
