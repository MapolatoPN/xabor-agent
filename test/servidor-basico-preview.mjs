import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const db=new URL(process.env.DATABASE_URL);
assert.equal(db.hostname,'127.0.0.1');assert.match(db.pathname,/^\/test_basico_/);
assert.match(process.env.NODE_OPTIONS||'',/red-solo-local/);
Object.assign(process.env,{NODE_ENV:'development',XABOR_ALTA_PUBLICA_BASICO:'false',XABOR_SUSCRIPCIONES_MP:'false'});
const {pool}=await import('../src/services/database.js');
const {rows}=await pool.query("SELECT 1 FROM usuarios WHERE email='qa-ui@ejemplo.invalid'");
if(!rows.length){
  const {hashPassword}=await import('../src/services/password.js');
  const {confirmarRegistroBasico,hashTokenRegistro}=await import('../src/services/registroBasico.js');
  const token=randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO solicitudes_registro_basico(email,token_hash,password_hash,nombre_propietario,nombre_negocio,expires_at)
    VALUES('qa-ui@ejemplo.invalid',$1,$2,'Persona sintética','Fonda La Esquina · QA',NOW()+INTERVAL '30 minutes')`,
    [hashTokenRegistro(token),hashPassword('QaMostrador2026!')]);
  await confirmarRegistroBasico(token);
}
await import('../src/server.js');
