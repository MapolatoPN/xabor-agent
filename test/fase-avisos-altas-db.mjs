import './entorno-superadmin-local.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool} from '../src/services/database.js';
import {confirmarRegistroBasico,hashTokenRegistro} from '../src/services/registroBasico.js';
process.env.XABOR_ALTA_BASICO_MODO='publico';
after(async()=>{await pool.end();});
async function solicitud(){
  const token=randomBytes(32).toString('hex'),email=randomUUID()+'@ejemplo.invalid';
  await pool.query(`INSERT INTO solicitudes_registro_basico(email,token_hash,password_hash,nombre_propietario,nombre_negocio,expires_at)
    VALUES($1,$2,'QA_HASH_SIN_ACCESO','Propietario QA','Aviso alta QA',now()+INTERVAL '30 minutes')`,[email,hashTokenRegistro(token)]);
  return {token,email};
}
test('la confirmación concurrente crea una sola alta y avisa después de que el COMMIT sea visible',async()=>{
  const s=await solicitud();let avisos=0,terminar;
  const notificado=new Promise(resolve=>terminar=resolve);
  const notificarAlta=async a=>{
    avisos++;assert.equal(a.email,s.email);
    const {rows:[n]}=await pool.query('SELECT negocio_id FROM solicitudes_registro_basico WHERE email=$1 AND used_at IS NOT NULL',[s.email]);
    assert(n?.negocio_id,'El aviso no debe ejecutarse antes del COMMIT');
    assert.equal((await pool.query('SELECT 1 FROM negocios WHERE id=$1',[n.negocio_id])).rowCount,1);
    terminar();return {enviado:true};
  };
  const rs=await Promise.allSettled([1,2].map(()=>confirmarRegistroBasico(s.token,{notificarAlta})));
  assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);assert.equal(rs.filter(r=>r.status==='rejected'&&r.reason.code==='ENLACE_INVALIDO').length,1);
  await Promise.race([notificado,new Promise((_,reject)=>setTimeout(()=>reject(Error('No llegó el aviso local')),2000).unref())]);
  assert.equal(avisos,1);
});
test('si falla el aviso, el negocio y su acceso permanecen creados y no se devuelve un error de registro',async()=>{
  const s=await solicitud();
  const r=await confirmarRegistroBasico(s.token,{notificarAlta:async()=>{throw Error('QA proveedor caído');}});
  assert.equal(r.ok,true);await new Promise(setImmediate);
  assert.equal((await pool.query('SELECT 1 FROM usuarios WHERE email=$1 AND activo=true',[s.email])).rowCount,1);
  assert.equal((await pool.query('SELECT 1 FROM solicitudes_registro_basico WHERE email=$1 AND used_at IS NOT NULL',[s.email])).rowCount,1);
});
test('un token inválido no crea un negocio ni envía un aviso',async()=>{
  let avisos=0;await assert.rejects(confirmarRegistroBasico('0'.repeat(64),{notificarAlta:()=>{avisos++;}}),e=>e.code==='ENLACE_INVALIDO');assert.equal(avisos,0);
});
