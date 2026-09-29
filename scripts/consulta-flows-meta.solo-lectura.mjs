// Viabilidad de Flows: SELECT en una transacción READ ONLY + GET a Meta.
// Nunca publica, envía mensajes, imprime secretos ni inicializa el servidor.
import assert from 'node:assert/strict';
import pg from 'pg';
import { descifrarSecretoIntegracion } from '../src/services/cifradoIntegraciones.js';

const negocioId = process.argv[2];
assert.match(negocioId || '', /^[a-f0-9-]{36}$/i);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
let cred, integracion, cfg;
try {
  await db.connect();
  await db.query('BEGIN READ ONLY');
  const ro = await db.query('SHOW transaction_read_only');
  assert.equal(ro.rows[0].transaction_read_only, 'on');
  const { rows } = await db.query(`SELECT ic.identificador, ic.waba_id, ic.business_id,
    cc.access_token_cifrado, cc.token_iv, cc.token_auth_tag, cc.token_formato_version
    FROM integraciones_canal ic LEFT JOIN integraciones_canal_credenciales cc ON cc.integracion_id=ic.id
    WHERE ic.negocio_id=$1 AND ic.canal='whatsapp' AND ic.activo IS TRUE`, [negocioId]);
  assert.equal(rows.length, 1, 'Se exige una integración activa inequívoca');
  integracion = rows[0];
  const conf = await db.query(`SELECT clave,valor FROM configuracion WHERE negocio_id=$1
    AND (clave LIKE 'int_wa_%' OR clave LIKE 'mesero_agente_%' OR clave LIKE 'whatsapp_%'
      OR clave='bot_whatsapp_solo_prueba')`, [negocioId]);
  cfg = Object.fromEntries(conf.rows.map(r => [r.clave,r.valor]));
  if (integracion.access_token_cifrado) cred = descifrarSecretoIntegracion({
    cifrado:integracion.access_token_cifrado, iv:integracion.token_iv,
    authTag:integracion.token_auth_tag, version:integracion.token_formato_version });
  else if (cfg.int_wa_phone_id === integracion.identificador) cred = cfg.int_wa_token;
  assert(cred, 'Sin credencial propia del negocio');
  console.log(JSON.stringify({database:'READ ONLY',
    canarioPorcentaje:cfg.mesero_agente_porcentaje, soloPrueba:cfg.bot_whatsapp_solo_prueba,
    telefonosCanario:(cfg.mesero_agente_telefonos || '').split(',').map(t=>'…'+t.trim().slice(-4)),
    tieneWaba:!!integracion.waba_id, tieneBusiness:!!integracion.business_id}));
} finally {
  await db.query('ROLLBACK').catch(()=>{});
  await db.end();
  console.log('Transacción de lectura terminada: ROLLBACK');
}
const get = async path => {
  const r = await fetch(`https://graph.facebook.com/v20.0/${path}`, {
    method:'GET', headers:{Authorization:`Bearer ${cred}`}, signal:AbortSignal.timeout(20000) });
  const j = await r.json();
  if (!r.ok) {
    console.log(JSON.stringify({consulta:path.split('?')[0].replace(/\d{6,}/g,'[id]'),status:r.status,
      code:j.error?.code,subcode:j.error?.error_subcode,
      mensaje:String(j.error?.message || '').replaceAll(cred,'[secreto]')}));
    return null;
  }
  return j;
};
const phone = await get(`${integracion.identificador}?fields=id,quality_rating,code_verification_status`);
console.log(JSON.stringify({numero:phone ? {quality:phone.quality_rating,verification:phone.code_verification_status}:null}));
let wabaId = integracion.waba_id || cfg.int_wa_waba_id;
if (!wabaId) {
  const debug = await get(`debug_token?input_token=${encodeURIComponent(cred)}`);
  console.log(JSON.stringify({permisos:debug?.data?.scopes || []}));
  const ids = [...new Set((debug?.data?.granular_scopes || [])
    .filter(s=>/^whatsapp_business/.test(s.scope)).flatMap(s=>s.target_ids || []))];
  for (const id of ids) {
    const phones = await get(`${id}/phone_numbers?fields=id&limit=100`);
    if (phones?.data?.some(p=>String(p.id)===String(integracion.identificador))) { wabaId=id; break; }
  }
}
if (!wabaId) { console.log('BLOQUEO: no se pudo identificar la WABA del número'); process.exitCode=2; }
else {
  const phones = await get(`${wabaId}/phone_numbers?fields=id&limit=100`);
  assert(phones?.data?.some(p=>String(p.id)===String(integracion.identificador)), 'WABA no verificada contra el número');
  const waba = await get(`${wabaId}?fields=id,name,owner_business_info,account_review_status`);
  console.log(JSON.stringify({waba:waba ? {id:waba.id,name:waba.name,review:waba.account_review_status}:null}));
  const businessId = integracion.business_id || waba?.owner_business_info?.id;
  if (businessId) {
    const biz=await get(`${businessId}?fields=id,verification_status`);
    console.log(JSON.stringify({negocioMeta:biz ? {verification:biz.verification_status}:null}));
  }
  const flows = await get(`${wabaId}/flows?fields=id,name,status,validation_errors&limit=100`);
  console.log(JSON.stringify({flows:flows?.data || null}));
}
