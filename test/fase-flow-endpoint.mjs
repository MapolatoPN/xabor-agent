import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import express from 'express';
import { registrarEndpointFlow,FlowNoDisponible } from '../src/mesero-agente/flowEndpoint.js';
import { peticionCifrada } from './lib-flow-cifrado.mjs';
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,
  privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}});
const env={WHATSAPP_FLOW_ENDPOINT:'true',WHATSAPP_FLOW_PRIVATE_KEY:privateKey,META_APP_SECRET:'solo-local'};
let llamadas=0;
const app=express();registrarEndpointFlow(app,{env,atender:async(_db,r)=>{
  llamadas++;if(r.flow_token==='invalido')throw new FlowNoDisponible();return {screen:'PLATILLO',data:{revision:'1'}};
}});
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const url=`http://127.0.0.1:${server.address().port}/webhook/flows/pedido`;
async function enviar(solicitud,cambio={}) {
  const p=peticionCifrada({version:'3.0',...solicitud},publicKey,env.META_APP_SECRET);
  const r=await fetch(url,{method:'POST',body:p.body,headers:p.headers,...cambio});return {r,p};
}
try {
  let {r,p}=await enviar({action:'ping'});assert.equal(r.status,200);assert.deepEqual(p.descifrar(await r.text()),{data:{status:'active'}});assert.equal(llamadas,0);
  ({r,p}=await enviar({action:'INIT',flow_token:'test'}));assert.equal(r.status,200);assert.equal(p.descifrar(await r.text()).screen,'PLATILLO');assert.equal(llamadas,1);
  ({r}=await enviar({action:'INIT'},{headers:{'Content-Type':'application/json','X-Hub-Signature-256':'sha256=abc'}}));assert.equal(r.status,432);assert.equal(llamadas,1);
  ({r,p}=await enviar({action:'INIT',flow_token:'invalido'}));assert.equal(r.status,427);assert.match(p.descifrar(await r.text()).error_msg,/no está disponible/);
  // Aviso de error del teléfono (4-oct): se contesta acknowledged, no llega al
  // borrador y su motivo queda en el log sin cifras largas. También sin la
  // versión «3.0», que es como llegó en producción (400 y el motivo perdido).
  const avisos=[],warn=console.warn;console.warn=(...a)=>avisos.push(a.join(' '));
  try {
    for(const version of ['3.0',undefined]) {
      ({r,p}=await enviar({version,action:'data_exchange',screen:'PERSONALIZAR',flow_token:'test',
        data:{error:'invalid-screen-transition',error_message:'Screen MENU is not reachable from PERSONALIZAR 5218787899919'}}));
      assert.equal(r.status,200);assert.deepEqual(p.descifrar(await r.text()),{data:{acknowledged:true}});
    }
  } finally {console.warn=warn;}
  assert.equal(llamadas,2,'el aviso no llega al borrador');
  assert.equal(avisos.length,2);
  assert.match(avisos[0],/\[FLOW\] Aviso de error del teléfono \(data_exchange PERSONALIZAR\): invalid-screen-transition — Screen MENU is not reachable from PERSONALIZAR …/);
  assert.doesNotMatch(avisos.join('\n'),/8787899919|test/,'sin teléfono ni token en el log');
  env.WHATSAPP_FLOW_ENDPOINT='false';({r}=await enviar({action:'INIT'}));assert.equal(r.status,503);
  assert.equal(llamadas,2);
  console.log('OK endpoint Flow HTTP: firma obligatoria, RSA/AES, ping sin DB, token inválido cifrado, aviso de error del teléfono y bandera apagada.');
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
