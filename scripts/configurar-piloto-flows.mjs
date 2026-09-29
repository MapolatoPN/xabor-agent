// Escritura operativa explícita: solamente estas cuatro claves del negocio.
// Nunca prende el bot maestro, levanta pausas, borra chats o amplía el canario.
import assert from 'node:assert/strict';
import pg from 'pg';
import { credencialFlows,clienteMetaFlows } from './lib-meta-flows.mjs';
const [negocioId,telefono,productosId,configurarId,modo]=process.argv.slice(2);
assert.equal(modo,'activar');assert.match(telefono,/^52\d{10,11}$/);
for(const id of [productosId,configurarId])assert.match(id,/^\d{5,30}$/);
const cred=await credencialFlows(negocioId),api=clienteMetaFlows(cred.token);
const flows=await api(`${cred.wabaId}/flows?fields=id,status,validation_errors&limit=100`);
for(const id of [productosId,configurarId]) {
  const f=flows.data.find(f=>f.id===id);assert.equal(f?.status,'PUBLISHED');assert(!f.validation_errors?.length);
}
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const normal=t=>t.startsWith('521') && t.length===13 ? `52${t.slice(3)}` : t;
const aliases=[normal(telefono),`521${normal(telefono).slice(2)}`];
try {
  await db.connect();await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");
  const {rows:[negocio]}=await db.query('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1 FOR UPDATE',[negocioId]);
  assert.equal(negocio?.bot_whatsapp_activo,true,'No reactivar automáticamente un bot apagado');
  const {rows}=await db.query(`SELECT clave,valor FROM configuracion WHERE negocio_id=$1 AND
    (clave LIKE 'mesero_agente_%' OR clave LIKE 'whatsapp_%' OR clave='bot_whatsapp_solo_prueba') FOR UPDATE`,[negocioId]);
  const cfg=Object.fromEntries(rows.map(r=>[r.clave,r.valor]));
  assert.equal(cfg.bot_whatsapp_solo_prueba,'true');assert.equal(Number(cfg.mesero_agente_porcentaje),0);
  assert.equal(cfg.mesero_agente_v1,'true');assert.notEqual(cfg.mesero_agente_shadow,'true');
  for(const k of ['whatsapp_interactivos_v1','whatsapp_interactivos_elecciones_v1'])assert.equal(cfg[k],'true');
  const actuales=String(cfg.mesero_agente_telefonos).split(/[,;\n]/).map(t=>t.trim()).filter(Boolean);
  assert(actuales.length && actuales.every(t=>normal(t)===normal(telefono)),'El canario no está limitado al mismo número');
  const {rows:[regla]}=await db.query("SELECT pg_get_constraintdef(oid) r FROM pg_constraint WHERE conrelid='agente_botones'::regclass AND conname='agente_botones_accion_check'");
  assert(regla.r.includes('flow_configurar'),'Migración 106 no desplegada');
  const valores={whatsapp_flow_productos_id:productosId,whatsapp_flow_configurar_id:configurarId,
    whatsapp_flows_telefonos:aliases.join(','),whatsapp_flows_v1:'true'};
  const antes=Object.fromEntries(Object.keys(valores).map(k=>[k,cfg[k] ?? null]));
  for(const [k,v] of Object.entries(valores))await db.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
    ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`,[negocioId,k,v]);
  await db.query('COMMIT');
  console.log(JSON.stringify({negocioId,telefono:'…'+telefono.slice(-4),porcentaje:0,antes,
    despues:{...valores,whatsapp_flows_telefonos:'mismo número, formatos 52/521'},botMaestro:'sin cambio',pausas:'sin cambio',conversacion:'sin cambio'}));
} catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
finally{await db.end();}
