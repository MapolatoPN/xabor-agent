import './entorno-superadmin-local.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pool } from '../src/services/database.js';
import { crearTokenSesion } from '../src/services/session.js';
import { usuarioPuedeAdministrarPersonalPropio } from '../src/services/personalService.js';
import { soloAdminDelNegocio, puedeAdministrarPersonal } from '../src/services/personalRutas.js';
import { crearSesionSoporte } from '../src/services/centralOperaciones.js';
import { cookie2faDe } from './lib-superadmin-2fa.mjs';
import { arrancarServidor } from './lib-servidor.mjs';
let srv, a,b,ajeno,dueno,normal,staff,superSinPermiso;
const suf=randomUUID().slice(0,8);
const query=async(sql,p=[])=>(await pool.query(sql,p)).rows;
const token=(uid,nid,rol='admin')=>crearTokenSesion({usuarioId:uid,negocioId:nid,rol});
async function pedir(ruta,uid=dueno,nid=a,{rol='admin',cookie,method='GET',body}={}) {
  const r=await fetch(srv.base+ruta,{method,headers:{Cookie:cookie||`xabor_sesion=${encodeURIComponent(token(uid,nid,rol))}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'manual'});
  return {status:r.status,datos:await r.json().catch(()=>null),headers:r.headers};
}
async function usuario(nid,rol,plataforma=false,permiso=false) {
  const [u]=await query(`INSERT INTO usuarios (negocio_id,nombre,email,activo) VALUES ($1,'QA acceso',$2,true) RETURNING id`,[nid,`${randomUUID()}@selector.test.local`]);
  await query(`INSERT INTO usuario_negocios (usuario_id,negocio_id,rol,activo) VALUES ($1,$2,$3,true)`,[u.id,nid,rol]);
  if(plataforma) await query(`INSERT INTO administradores_plataforma(usuario_id,activo,personal_en_negocios_propios) VALUES ($1,true,$2)`,[u.id,permiso]);
  return u.id;
}
before(async()=>{
  await pool.query(readFileSync(new URL('../migrations/162_superadmin_personal_propio.sql',import.meta.url),'utf8'));
  const ids=[];
  for(const nombre of ['propia-a','propia-b','ajena']) {
    const [n]=await query(`INSERT INTO negocios(nombre,slug,activo,estado) VALUES ($1,$2,true,'activo') RETURNING id`,[nombre,`qa-selector-${nombre}-${suf}`]);
    ids.push(n.id);
    await query(`INSERT INTO negocio_modulos(negocio_id,modulo,estado) VALUES ($1,'personal','activo')`,[n.id]);
  }
  [a,b,ajeno]=ids;
  dueno=await usuario(a,'admin',true,true);
  await query(`INSERT INTO usuario_negocios(usuario_id,negocio_id,rol,activo) VALUES ($1,$2,'admin',true)`,[dueno,b]);
  normal=await usuario(a,'admin'); staff=await usuario(a,'staff'); superSinPermiso=await usuario(a,'admin',true);
  srv=await arrancarServidor({PORT:'4941',XABOR_CONCILIACION_AUTOMATICA:'false'});
});
after(async()=>{srv?.detener(); await pool.end();});

test('la migración y su predeploy son idempotentes y no conceden permisos ni cambian registros',async()=>{
  const antes=await query('SELECT * FROM administradores_plataforma ORDER BY id');
  for(let i=0;i<2;i++) execFileSync(process.execPath,['scripts/predeploy-162-superadmin-personal.mjs'],{stdio:'pipe',env:process.env});
  assert.deepEqual(await query('SELECT * FROM administradores_plataforma ORDER BY id'),antes);
  const [s]=await query('SELECT personal_en_negocios_propios FROM administradores_plataforma WHERE usuario_id=$1',[superSinPermiso]);
  assert.equal(s.personal_en_negocios_propios,false);
});
test('el selector anuncia superadmin sin ampliar las sucursales del dueño',async()=>{
  const r=await pedir('/api/auth/sucursales'); assert.equal(r.status,200);
  assert.equal(r.datos.puedeAbrirSuperadmin,true); assert.equal(r.datos.puedeCambiar,true);
  assert.deepEqual(r.datos.sucursales.map(n=>n.negocioId).sort(),[a,b].sort());
});
test('admin y staff ordinarios no reciben el acceso de plataforma',async()=>{
  for(const [id,rol] of [[normal,'admin'],[staff,'staff']]) {
    const r=await pedir('/api/auth/sucursales',id,a,{rol}); assert.equal(r.status,200);
    assert.equal(r.datos.puedeAbrirSuperadmin,false);
    assert.equal((await pedir('/api/superadmin/dashboard',id,a,{rol})).status,403);
  }
});
test('la entrada del selector no sustituye el segundo factor del superadmin',async()=>{
  assert.equal((await pedir('/api/superadmin/dashboard')).status,403);
  const t=token(dueno,a); const cookie=`xabor_sesion=${encodeURIComponent(t)}; ${await cookie2faDe({usuarioId:dueno,tokenSesion:t})}`;
  assert.equal((await pedir('/api/superadmin/dashboard',dueno,a,{cookie})).status,200);
});
test('el dueño conserva Empleados en sus dos negocios y la visibilidad coincide con las rutas',async()=>{
  for(const nid of [a,b]) {
    assert.equal(await usuarioPuedeAdministrarPersonalPropio(dueno,nid),true);
    assert.equal((await pedir('/api/auth/me',dueno,nid)).datos.puedeAdministrarPersonal,true);
    assert.equal((await pedir('/api/personal/empleados',dueno,nid)).status,200);
  }
});
test('el admin normal conserva Empleados; staff no obtiene el permiso',async()=>{
  assert.equal((await pedir('/api/personal/empleados',normal)).status,200);
  assert.equal((await pedir('/api/personal/empleados',staff,a,{rol:'staff'})).status,403);
});
test('un superadmin sin autorización explícita permanece bloqueado para Empleados',async()=>{
  assert.equal((await pedir('/api/auth/me',superSinPermiso)).datos.puedeAdministrarPersonal,false);
  assert.equal((await pedir('/api/personal/empleados',superSinPermiso)).datos.codigo,'superadmin_sin_acceso_personal');
});
test('un superadmin autorizado tampoco accede a Empleados desde soporte, aun en su propio negocio',async()=>{
  for(const nid of [a,ajeno]) {
    const s=await crearSesionSoporte(dueno,nid,'QA aislamiento de Personal');
    const cookie=`xabor_sesion=${encodeURIComponent(s.token)}`;
    const me=await pedir('/api/auth/me',dueno,nid,{cookie});
    assert.equal(me.datos.soporte.activo,true); assert.equal(me.datos.puedeAdministrarPersonal,false);
    assert.equal((await pedir('/api/auth/sucursales',dueno,nid,{cookie})).datos.puedeAbrirSuperadmin,false);
    for(const method of ['GET','POST']) {
      const r=await pedir('/api/personal/empleados',dueno,nid,{cookie,method,body:method==='POST'?{nombre:'No autorizado',numero:9191}:undefined});
      assert.equal(r.status,403); assert.equal(r.datos.codigo,'superadmin_sin_acceso_personal');
    }
  }
});
test('el permiso no da acceso a un negocio ajeno ni permite cambiar a él',async()=>{
  assert.equal(await usuarioPuedeAdministrarPersonalPropio(dueno,ajeno),false);
  assert.equal((await pedir('/api/personal/empleados',dueno,ajeno)).status,403);
  assert.equal((await pedir('/api/auth/cambiar-sucursal',dueno,a,{method:'POST',body:{negocioId:ajeno}})).status,403);
});
test('revocar membresía o convertirla a staff retira Empleados incluso con un token anterior de admin',async()=>{
  for(const cambio of ["activo=false","rol='staff'"]) {
    await query(`UPDATE usuario_negocios SET ${cambio} WHERE usuario_id=$1 AND negocio_id=$2`,[dueno,b]);
    try {
      assert.equal(await usuarioPuedeAdministrarPersonalPropio(dueno,b),false);
      assert.equal((await pedir('/api/personal/empleados',dueno,b)).status,403);
    } finally {await query(`UPDATE usuario_negocios SET activo=true,rol='admin' WHERE usuario_id=$1 AND negocio_id=$2`,[dueno,b]);}
  }
});
test('apagar Personal oculta la entrada y rechaza la ruta aun con permiso de dueño',async()=>{
  await query("UPDATE negocio_modulos SET estado='suspendido' WHERE negocio_id=$1 AND modulo='personal'",[a]);
  try {
    assert.equal((await pedir('/api/auth/me')).datos.puedeAdministrarPersonal,false);
    assert.equal((await pedir('/api/personal/empleados')).status,403);
  } finally {await query("UPDATE negocio_modulos SET estado='activo' WHERE negocio_id=$1 AND modulo='personal'",[a]);}
});
test('revocar el permiso de dueño se aplica inmediatamente sin alterar las membresías',async()=>{
  await query('UPDATE administradores_plataforma SET personal_en_negocios_propios=false WHERE usuario_id=$1',[dueno]);
  try {
    assert.equal((await pedir('/api/personal/empleados')).status,403);
    assert.equal((await pedir('/api/auth/me')).datos.puedeAdministrarPersonal,false);
  } finally {await query('UPDATE administradores_plataforma SET personal_en_negocios_propios=true WHERE usuario_id=$1',[dueno]);}
});
test('revocar superadmin retira inmediatamente la entrada y el acceso a plataforma',async()=>{
  await query('UPDATE administradores_plataforma SET activo=false WHERE usuario_id=$1',[dueno]);
  try {
    assert.equal((await pedir('/api/auth/sucursales')).datos.puedeAbrirSuperadmin,false);
    assert.equal((await pedir('/api/superadmin/dashboard')).status,403);
    assert.equal((await pedir('/api/personal/empleados')).status,200,'su membresía de negocio sigue siendo válida');
  } finally {await query('UPDATE administradores_plataforma SET activo=true WHERE usuario_id=$1',[dueno]);}
});
test('la nueva cuenta puede cambiar entre sus sucursales sin obtener membresías nuevas',async()=>{
  const antes=await query('SELECT negocio_id,rol,activo FROM usuario_negocios WHERE usuario_id=$1 ORDER BY negocio_id',[dueno]);
  const r=await pedir('/api/auth/cambiar-sucursal',dueno,a,{method:'POST',body:{negocioId:b}});
  assert.equal(r.status,200); assert.equal(r.datos.negocioId,b);
  assert.match(r.headers.get('set-cookie'),/xabor_sesion=/);
  assert.deepEqual(await query('SELECT negocio_id,rol,activo FROM usuario_negocios WHERE usuario_id=$1 ORDER BY negocio_id',[dueno]),antes);
});
test('un fallo de base cierra la ruta y oculta el módulo; soporte se rechaza antes de consultar',async()=>{
  const original=pool.query; pool.query=async()=>{throw Error('QA sin base');};
  try {
    const res={status(n){this.codigo=n;return this;},json() {return this;}};
    await soloAdminDelNegocio({usuarioId:dueno,negocioId:a},res,()=>assert.fail('no debe pasar'));
    assert.equal(res.codigo,503);
    assert.equal(await puedeAdministrarPersonal({rol:'admin',usuarioId:dueno,negocioId:a,modulos:['personal']}),false);
    await soloAdminDelNegocio({esSoporte:true},res,()=>assert.fail('soporte no pasa'));
    assert.equal(res.codigo,403);
  } finally {pool.query=original;}
});
