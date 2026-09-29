import assert from 'node:assert/strict';
import pg from 'pg';
import { descifrarSecretoIntegracion } from '../src/services/cifradoIntegraciones.js';
export async function credencialFlows(negocioId) {
  assert.match(negocioId || '',/^[a-f0-9-]{36}$/i);
  const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
  try {
    await db.connect();await db.query('BEGIN READ ONLY');
    assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
    const {rows}=await db.query(`SELECT ic.identificador,ic.waba_id,cc.access_token_cifrado,
      cc.token_iv,cc.token_auth_tag,cc.token_formato_version FROM integraciones_canal ic
      JOIN integraciones_canal_credenciales cc ON cc.integracion_id=ic.id
      WHERE ic.negocio_id=$1 AND ic.canal='whatsapp' AND ic.proveedor='meta' AND ic.activo IS TRUE`,[negocioId]);
    assert.equal(rows.length,1,'Integración propia inequívoca requerida');
    const r=rows[0];assert(r.waba_id);
    return {wabaId:r.waba_id,phoneId:r.identificador,token:descifrarSecretoIntegracion({
      cifrado:r.access_token_cifrado,iv:r.token_iv,authTag:r.token_auth_tag,version:r.token_formato_version})};
  } finally {await db.query('ROLLBACK').catch(()=>{});await db.end();}
}
export function clienteMetaFlows(token) {
  return async (path,{method='GET',body}={})=>{
    assert(/^[\d/?a-zA-Z_=&,.-]+$/.test(path),'Ruta Meta no válida');
    const r=await fetch(`https://graph.facebook.com/v20.0/${path}`,{method,body,
      headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
    const j=await r.json();
    if(!r.ok)throw Error(`Meta ${r.status} código ${j.error?.code}: ${String(j.error?.message || '').replaceAll(token,'[secreto]')}`);
    return j;
  };
}
