// Activación explícita de UNA clave, solo para el piloto existente del dueño.
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { definicionFlowRepetible } from './definicion-flow-repetible.mjs';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { credencialFlows,clienteMetaFlows } from './lib-meta-flows.mjs';
const [negocioId,telefono,flowId,modo,tipo='repetible']=process.argv.slice(2);
assert(['repetible','categorias'].includes(tipo));
const clave=tipo==='categorias'?'whatsapp_flow_categorias_id':'whatsapp_flow_repetible_id';
assert.equal(modo,'activar');assert.equal(negocioId,'5de544d8-9a0a-4972-9c92-fd48ff22de66');
const normal=t=>t.startsWith('521') && t.length===13?`52${t.slice(3)}`:t;
assert.equal(normal(telefono || ''),'528787899919');assert.match(flowId || '',/^\d{5,30}$/);
const cred=await credencialFlows(negocioId),api=clienteMetaFlows(cred.token);
const lista=await api(`${cred.wabaId}/flows?fields=id,name,status,endpoint_uri,validation_errors&limit=100`);
const f=lista.data.find(x=>x.id===flowId);
const sha=createHash('sha256').update(JSON.stringify(tipo==='categorias'?definicionFlowCategorias():definicionFlowRepetible())).digest('hex');
assert.equal(f?.name,`xabor_${tipo}_agrupado_${sha.slice(0,12)}`);
assert.equal(f.status,'PUBLISHED');assert(!f.validation_errors?.length);
assert.equal(f.endpoint_uri,'https://xabor.mx/webhook/flows/pedido');
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
try {
  await db.connect();await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");
  const {rows:[n]}=await db.query('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1 FOR UPDATE',[negocioId]);
  assert.equal(n?.bot_whatsapp_activo,true,'No reactivar el bot maestro');
  assert((await db.query("SELECT to_regclass('agente_flows_borradores') t")).rows[0].t,'Migración 107 ausente');
  const {rows}=await db.query('SELECT clave,valor FROM configuracion WHERE negocio_id=$1 FOR UPDATE',[negocioId]);
  const cfg=Object.fromEntries(rows.map(r=>[r.clave,r.valor]));
  for(const k of ['bot_whatsapp_solo_prueba','mesero_agente_v1','whatsapp_flows_v1','whatsapp_interactivos_v1','whatsapp_interactivos_elecciones_v1'])assert.equal(cfg[k],'true',k);
  assert.equal(Number(cfg.mesero_agente_porcentaje),0);assert.notEqual(cfg.mesero_agente_shadow,'true');
  for(const k of ['mesero_agente_telefonos','whatsapp_flows_telefonos']) {
    const telefonos=String(cfg[k] || '').split(/[,;\n]/).map(t=>t.trim()).filter(Boolean);
    assert(telefonos.length && telefonos.every(t=>normal(t)===normal(telefono)),'No ampliar el alcance de la prueba');
  }
  await db.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
    ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`,[negocioId,clave,flowId]);
  await db.query('COMMIT');
  console.log(JSON.stringify({negocioId,telefono:'…9919',clave,
    antes:cfg[clave] || null,despues:flowId,canario:'mismo número',conversacion:'sin cambios',botMaestro:'sin cambios',pausas:'sin cambios'}));
} catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
finally{await db.end();}
