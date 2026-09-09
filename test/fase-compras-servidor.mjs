// Prueba el montaje real de server.js y su sesión/membresía (sin auth simulada).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { arrancarServidor } from './lib-servidor.mjs';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Solo DB local desechable');
const seed=JSON.parse(await readFile(new URL('./.datos-prueba.json',import.meta.url),'utf8'));
const {crearTokenSesion}=await import('../src/services/session.js');
const {pool}=await import('../src/services/database.js');
const cookie=(id,tenant,rol)=>'xabor_sesion='+encodeURIComponent(crearTokenSesion({usuarioId:id,negocioId:tenant,rol}));
const admin=cookie(seed.adminNegocioAUsuarioId,seed.negocioA,'admin');
const staff=cookie(seed.staffNegocioAUsuarioId,seed.negocioA,'staff');
const srv=await arrancarServidor({PORT:process.env.TEST_PORT||'4967',NODE_ENV:'test',WHATSAPP_TOKEN:'',ANTHROPIC_API_KEY:'',OPENAI_API_KEY:''},{timeoutMs:30000});
const request=(path,auth=admin,method='GET',body)=>fetch(srv.base+'/api/admin/compras'+path,{method,headers:{...(auth?{Cookie:auth}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
let passed=0;
async function t(name,fn){await fn();passed++;console.log('OK',name);}
let compraId,responsableId;
try{
  await t('montaje real sirve pantalla y assets de Compras',async()=>{for(const p of ['/compras.html','/compras.css','/compras.js'])assert.equal((await fetch(srv.base+p)).status,200);});
  await t('sin sesión no hay acceso; cookie de admin sí',async()=>{assert.equal((await request('',null)).status,401);assert.equal((await request('/contexto')).status,200);});
  await t('rol no viene de la cookie si contradice membresía real',async()=>{
    const forged=cookie(seed.staffNegocioAUsuarioId,seed.negocioA,'admin');
    assert.equal((await request('/fondos',forged,'POST',{})).status,403);
  });
  await t('usuario A no puede elegir B en la cookie',async()=>{const bad=cookie(seed.adminNegocioAUsuarioId,seed.negocioB,'admin');assert.equal((await request('/contexto',bad)).status,403);});
  await t('staff captura pero negocio_id del cuerpo no cambia el dueño',async()=>{
    const res=await request('/manual',staff,'POST',{negocio_id:seed.negocioB,proveedor:'Prueba servidor',fecha:'2026-09-01',total:100,tipo_pago:'credito'});assert.equal(res.status,201);const c=await res.json();compraId=c.id;assert.equal(c.negocio_id,seed.negocioA);
    assert.equal((await request('/'+c.id+'/confirmar',staff,'POST',{version:c.version})).status,200);
  });
  await t('admin registra responsable, fondo y pago por rutas reales',async()=>{
    let res=await request('/responsables',admin,'POST',{nombre:'Servidor '+randomUUID()});assert.equal(res.status,201);const r=await res.json();responsableId=r.id;
    res=await request('/fondos',admin,'POST',{responsable_id:r.id,monto:100,fecha:'2026-09-01',tipo:'entrega',clave_operacion:randomUUID()});assert.equal(res.status,201);
    res=await request('/'+compraId+'/pagos',admin,'POST',{origen:'fondo',responsable_id:r.id,monto:100,fecha:'2026-09-01',clave_operacion:randomUUID()});assert.equal(res.status,201);
    const c=await (await request('/'+compraId)).json();assert.equal(c.pendiente,0);assert.equal(c.pagado,100);
    assert.equal((await request('/'+compraId+'/pagos',staff,'POST',{})).status,403);
  });
  await t('enlace de Compras presente en panel; bot y tienda conservan su punto de entrada',async()=>{
    const html=await (await fetch(srv.base+'/app')).text();assert.match(html,/id="tab-compras"[^>]*location.href='\/compras.html'/);
    assert.equal((await fetch(srv.base+'/health')).status,200);
    assert.equal((await fetch(srv.base+'/api/tienda/slug-inexistente-compras')).status,404);
  });
  console.log(`Compras servidor real: ${passed}/${passed}`);
}finally{
  srv.detener();
  // Solo filas creadas por esta prueba.
  if(compraId){await pool.query('DELETE FROM compras_pagos WHERE negocio_id=$1 AND compra_id=$2',[seed.negocioA,compraId]);await pool.query('DELETE FROM compras_operativas WHERE negocio_id=$1 AND id=$2',[seed.negocioA,compraId]);}
  if(responsableId){await pool.query('DELETE FROM fondos_compras WHERE negocio_id=$1 AND responsable_id=$2',[seed.negocioA,responsableId]);await pool.query('DELETE FROM compras_responsables WHERE negocio_id=$1 AND id=$2',[seed.negocioA,responsableId]);}
  await pool.end();
}
