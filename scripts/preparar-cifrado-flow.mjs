// Operación autorizada explícitamente. No guarda claves en disco, no las
// imprime y NO dispara deployments. No reemplaza claves públicas ajenas.
import assert from 'node:assert/strict';
import { generateKeyPairSync,createPublicKey,createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { credencialFlows,clienteMetaFlows } from './lib-meta-flows.mjs';
const [negocioId,modo]=process.argv.slice(2);
assert.equal(modo,'preparar','Especifica preparar para autorizar la operación');
assert.equal(negocioId,'5de544d8-9a0a-4972-9c92-fd48ff22de66','Operación limitada al piloto autorizado');
const destino=['--project','f38167de-f48c-457f-972c-3bc0a48c6135',
  '--environment','23ef5879-22be-4740-9d47-34984792631d','--service','c96c7b8f-dece-4c16-8c91-629001505ac2'];
const ejecutable=process.env.RAILWAY_EXECUTABLE;
assert(ejecutable && isAbsolute(ejecutable) && existsSync(ejecutable),'RAILWAY_EXECUTABLE debe apuntar al binario instalado');
function railway(args,input) {
  try {return execFileSync(ejecutable,['variable',...args,...destino,'--json'],
    {input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});}
  catch {throw Error('Railway no completó la operación de variables. Salida omitida para proteger secretos.');}
}
const leer=()=>{try{return JSON.parse(railway(['list']));}catch{throw Error('No se pudieron leer las variables de Railway de forma segura.');}};
const cred=await credencialFlows(negocioId),api=clienteMetaFlows(cred.token);
const phones=await api(`${cred.wabaId}/phone_numbers?fields=id&limit=100`);
assert(phones.data.some(p=>p.id===cred.phoneId),'Número ajeno a la WABA');
const registro=await api(`${cred.phoneId}/whatsapp_business_encryption`);
assert((registro.data?.length || 0)<=1,'Más de una clave: requiere revisión');
const publicaAnterior=String(registro.data?.[0]?.business_public_key || '').trim();
const vars=leer();assert(vars.META_APP_SECRET,'Falta el secreto de firma de Meta');
assert(!Object.hasOwn(vars,'WHATSAPP_FLOW_PRIVATE_KEY') || vars.WHATSAPP_FLOW_PRIVATE_KEY,
  'Clave sellada o vacía: no reemplazarla sin revisión');
let privada=vars.WHATSAPP_FLOW_PRIVATE_KEY;
const nueva=!privada;
assert(privada || !publicaAnterior,'Ya existe una clave pública y no tenemos su privada; no reemplazar');
if(!privada)privada=generateKeyPairSync('rsa',{modulusLength:2048,
  privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
const publica=createPublicKey(privada).export({type:'spki',format:'pem'});
const huella=k=>createHash('sha256').update(createPublicKey(k).export({type:'spki',format:'der'})).digest('hex');
if(publicaAnterior)assert.equal(huella(publicaAnterior),huella(publica),'La clave existente es distinta; no reemplazar');
if(nueva)railway(['set','WHATSAPP_FLOW_PRIVATE_KEY','--stdin','--skip-deploys'],privada);
assert.equal(huella(leer().WHATSAPP_FLOW_PRIVATE_KEY),huella(publica),'La clave persistida no coincide');
if(!publicaAnterior) {
  const body=new FormData();body.set('business_public_key',publica);
  const r=await api(`${cred.phoneId}/whatsapp_business_encryption`,{method:'POST',body});assert.equal(r.success,true);
}
const final=await api(`${cred.phoneId}/whatsapp_business_encryption`);
assert.equal(huella(final.data[0].business_public_key),huella(publica));
assert.equal(final.data[0].business_public_key_signature_status,'VALID');
railway(['set','WHATSAPP_FLOW_ENDPOINT=true','--skip-deploys']);
console.log(JSON.stringify({negocioId,clave:nueva?'creada y guardada solo en Railway':'reutilizada',
  publicaSha256:huella(publica),estadoMeta:'VALID',deploymentDisparado:false,canario:'sin cambios'}));
