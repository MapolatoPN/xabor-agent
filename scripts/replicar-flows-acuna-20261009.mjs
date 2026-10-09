// Operación del propietario: dejar en Acuña las mismas definiciones publicadas
// que ya funcionan en Obispado. No envía mensajes, registra pedidos ni cobra.
// plan: solo lectura; preparar: crea/publica en Meta; configurar: corrige IDs
// propios en SQL con respaldo y auditoría. No enciende el bot.
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import pg from 'pg';
import { credencialFlows, clienteMetaFlows } from './lib-meta-flows.mjs';
const [modo] = process.argv.slice(2);
assert(['plan','preparar','configurar'].includes(modo), 'Modo explícito requerido');
const DESTINO = 'bb27290a-3359-4348-ba60-03d89f97127f';
const ORIGEN = '5de544d8-9a0a-4972-9c92-fd48ff22de66';
const RESPALDO = 'whatsapp_flows_acuna_reparacion_20261009';
const ENDPOINT = 'https://xabor.mx/webhook/flows/pedido';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 15000 });
const hash = x => createHash('sha256').update(x).digest('hex');
const keyHash = k => hash(createPublicKey(k).export({type:'spki',format:'der'}));
const leerCfg = async id => Object.fromEntries((await db.query('SELECT clave,valor FROM configuracion WHERE negocio_id=$1',[id])).rows.map(r=>[r.clave,r.valor]));
const configuradas = cfg => Object.entries(cfg).filter(([k,v])=>/^whatsapp_flow_[a-z_]+_id$/.test(k)&&/^\d{5,30}$/.test(v));
try {
  await db.connect(); await db.query('BEGIN READ ONLY');
  const ns = (await db.query('SELECT id,slug,bot_whatsapp_activo FROM negocios WHERE id=ANY($1::uuid[])',[[DESTINO,ORIGEN]])).rows;
  assert.equal(ns.find(n=>n.id===DESTINO)?.slug,'mapolato-acuna');
  assert.equal(ns.find(n=>n.id===ORIGEN)?.slug,'mapolato-obispado');
  assert.equal(ns.find(n=>n.id===DESTINO).bot_whatsapp_activo,false,'No reparar IDs con el bot atendiendo');
  const anterior=await leerCfg(DESTINO),fuente=await leerCfg(ORIGEN);
  const claves=configuradas(anterior);
  assert(claves.length>0);
  for(const[k]of claves)assert(/^\d{5,30}$/.test(fuente[k]),'No hay definición fuente para '+k);
  await db.query('ROLLBACK');
  const origen=await credencialFlows(ORIGEN),destino=await credencialFlows(DESTINO);
  assert.notEqual(origen.wabaId,destino.wabaId,'Las cuentas deben ser distintas');
  const apiOrigen=clienteMetaFlows(origen.token),api=clienteMetaFlows(destino.token);
  const phones=await api(`${destino.wabaId}/phone_numbers?fields=id&limit=100`);
  assert(phones.data.some(n=>n.id===destino.phoneId),'Número fuera de la cuenta destino');
  const originales=(await apiOrigen(`${origen.wabaId}/flows?fields=id,name,status,endpoint_uri,validation_errors&limit=100`)).data;
  const propios=(await api(`${destino.wabaId}/flows?fields=id,name,status,validation_errors&limit=100`)).data;
  const recetas=claves.map(([clave])=>{
    const id=fuente[clave];
    const f=originales.find(f=>f.id===id); assert(f,'Flow fuente no encontrado: '+clave);
    assert.equal(f.status,'PUBLISHED');assert(!(f.validation_errors||[]).length);
    assert(!f.endpoint_uri||f.endpoint_uri===ENDPOINT,'Endpoint ajeno');
    return {clave,fuenteId:id,fuente:f,destino:propios.find(x=>x.name===f.name)};
  });
  if(modo==='plan')console.log(JSON.stringify({modo,formularios:recetas.map(r=>({clave:r.clave,propioPublicado:r.destino?.status==='PUBLISHED'})),botActivo:false}));
  else if(modo==='preparar'){
    const encryption=(await api(`${destino.phoneId}/whatsapp_business_encryption`)).data?.[0];
    assert.equal(encryption?.business_public_key_signature_status,'VALID');
    assert.equal(keyHash(encryption.business_public_key),keyHash(process.env.WHATSAPP_FLOW_PRIVATE_KEY));
    // Descargar primero todas las definiciones; ninguna escritura antes de
    // confirmar que son JSON de Flows publicados y de tamaño razonable.
    for(const r of recetas){
      const assets=await apiOrigen(`${r.fuenteId}/assets`);
      const asset=assets.data?.find(a=>a.asset_type==='FLOW_JSON');assert(asset?.download_url);
      const respuesta=await fetch(asset.download_url,{signal:AbortSignal.timeout(30000)});assert(respuesta.ok);
      r.json=await respuesta.text();assert(Buffer.byteLength(r.json)<5*1024*1024);
      const j=JSON.parse(r.json);assert(j.version&&Array.isArray(j.screens)&&j.screens.length);
    }
    for(const r of recetas){
      let f=r.destino;
      if(!f){f=await api(`${destino.wabaId}/flows`,{method:'POST',body:new URLSearchParams({name:r.fuente.name,categories:'["OTHER"]',...(r.fuente.endpoint_uri?{endpoint_uri:r.fuente.endpoint_uri}:{})})});f.status='DRAFT';}
      if(f.status==='DRAFT'){
        const body=new FormData();body.set('name','flow.json');body.set('asset_type','FLOW_JSON');body.set('file',new Blob([r.json],{type:'application/json'}),'flow.json');
        const validacion=await api(`${f.id}/assets`,{method:'POST',body});assert(!(validacion.validation_errors||[]).length,'Meta rechazó '+r.clave);
        const actual=await api(`${f.id}?fields=id,status,validation_errors,health_status`);assert(!(actual.validation_errors||[]).length);
        const bloqueadas=actual.health_status?.entities?.filter(e=>e.can_send_message!=='AVAILABLE')||[];
        assert(actual.health_status?.can_send_message==='AVAILABLE'||(bloqueadas.length&&bloqueadas.every(e=>e.entity_type==='WABA'&&e.errors?.length&&e.errors.every(x=>x.error_code===141006))),'Restricción de Meta en '+r.clave);
        assert.equal((await api(`${f.id}/publish`,{method:'POST'})).success,true);
      }
      const final=await api(`${f.id}?fields=id,name,status,validation_errors,endpoint_uri`);assert.equal(final.status,'PUBLISHED');assert(!(final.validation_errors||[]).length);assert.equal(final.endpoint_uri||'',r.fuente.endpoint_uri||'');
      console.log(JSON.stringify({clave:r.clave,publicado:true,definicionSha256:hash(r.json)}));
    }
  }else{
    const cambios={};for(const r of recetas){assert.equal(r.destino?.status,'PUBLISHED','Preparar primero '+r.clave);assert(!(r.destino.validation_errors||[]).length);cambios[r.clave]=r.destino.id;}
    await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='3s'");
    const{rows:[n]}=await db.query('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1 FOR UPDATE',[DESTINO]);assert.equal(n.bot_whatsapp_activo,false);
    const actual=await leerCfg(DESTINO);for(const[k,v]of claves)assert.equal(actual[k],v,'Cambio concurrente '+k);
    assert(!actual[RESPALDO],'La reparación ya tiene respaldo; revisar antes de repetir');
    const{rows:actores}=await db.query("SELECT u.id FROM administradores_plataforma ap JOIN usuarios u ON u.id=ap.usuario_id WHERE ap.activo AND u.activo AND lower(u.nombre)='mario'");assert.equal(actores.length,1,'Actor propietario no inequívoco');
    const antes=Object.fromEntries(claves),respaldo={antes,despues:cambios,botAntes:false,fecha:new Date().toISOString()};
    await db.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)',[DESTINO,RESPALDO,JSON.stringify(respaldo)]);
    for(const[k,v]of Object.entries(cambios))await db.query('UPDATE configuracion SET valor=$3 WHERE negocio_id=$1 AND clave=$2',[DESTINO,k,v]);
    await db.query(`INSERT INTO auditoria_plataforma(superadmin_id,accion,negocio_id,estado_anterior,estado_nuevo,contexto)
      VALUES($1,'reparar_formularios_cuenta_propia',$2,$3,$4,$5)`,[actores[0].id,DESTINO,JSON.stringify(antes),JSON.stringify(cambios),JSON.stringify({autorizacion:'Formularios disponibles en Obispado y Acuña',respaldo:RESPALDO,envios:0})]);
    await db.query('COMMIT');console.log(JSON.stringify({modo,clavesCorregidas:Object.keys(cambios).length,respaldo:RESPALDO,botActivo:false}));
  }
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error('Operación detenida:',e.message);process.exitCode=1;}finally{await db.end();}
