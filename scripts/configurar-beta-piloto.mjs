// Operación explícita del piloto del dueño. No modifica master, otras listas,
// porcentajes, pausas, conversaciones ni pedidos. Sin modo activar: solo lectura.
import assert from 'node:assert/strict';
import pg from 'pg';
import {createHash} from 'node:crypto';
import {credencialFlows,clienteMetaFlows} from './lib-meta-flows.mjs';
import {definicionFlowCarrito} from './definicion-flow-carrito.mjs';
const [modo,flowId,flowAnterior]=process.argv.slice(2);
assert(['inspeccionar','activar'].includes(modo),'Indica inspeccionar o activar');
const negocioId='5de544d8-9a0a-4972-9c92-fd48ff22de66',telefono='528787899919';
const normal=t=>/^521\d{10}$/.test(t)?`52${t.slice(3)}`:t;
const claves=['bot_whatsapp_solo_prueba','mesero_agente_v1','mesero_agente_porcentaje','mesero_agente_shadow',
  'mesero_agente_telefonos','whatsapp_flows_telefonos','whatsapp_flows_v1','whatsapp_interactivos_v1',
  'whatsapp_interactivos_elecciones_v1','whatsapp_flow_carrito_id','whatsapp_beta_hibrido_v1',
  'whatsapp_beta_telefonos','whatsapp_flow_carrito_duplicar_v1','whatsapp_catalogo_nativo_v1'];
assert(process.env.DATABASE_URL,'Se requiere conexión explícita');
if(modo==='activar') {
  assert.match(flowId || '',/^\d{5,30}$/);assert.match(flowAnterior || '',/^\d{5,30}$/);
  const cred=await credencialFlows(negocioId),api=clienteMetaFlows(cred.token);
  const lista=await api(`${cred.wabaId}/flows?fields=id,name,status,endpoint_uri,validation_errors&limit=100`);
  const f=lista.data.find(x=>x.id===flowId);
  const sha=createHash('sha256').update(JSON.stringify(definicionFlowCarrito({duplicar:true}))).digest('hex');
  assert.equal(f?.name,`xabor_carrito_agrupado_${sha.slice(0,12)}`,'Definición distinta a la beta revisada');
  assert.equal(f.status,'PUBLISHED');assert(!f.validation_errors?.length);
  assert.equal(f.endpoint_uri,'https://xabor.mx/webhook/flows/pedido');
}
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
try {
  await db.connect();await db.query(modo==='activar'?'BEGIN':'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout='5s'");
  const {rows:[negocio]}=await db.query(`SELECT bot_whatsapp_activo FROM negocios WHERE id=$1 ${modo==='activar'?'FOR UPDATE':''}`,[negocioId]);
  assert(negocio,'Negocio no encontrado');
  const {rows}=await db.query(`SELECT clave,valor FROM configuracion WHERE negocio_id=$1 AND clave=ANY($2::text[]) ${modo==='activar'?'FOR UPDATE':''}`,[negocioId,claves]);
  const cfg=Object.fromEntries(rows.map(r=>[r.clave,r.valor]));
  const {rows:pausas}=await db.query('SELECT telefono,bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=ANY($2::text[])',[negocioId,[telefono,'5218787899919']]);
  console.log(JSON.stringify({modo,botMaestro:negocio.bot_whatsapp_activo,configuracion:cfg,pausas}));
  if(modo==='activar') {
    assert.equal(negocio.bot_whatsapp_activo,true,'No reactivar el bot maestro');
    assert((await db.query("SELECT to_regclass('agente_flows_borradores') t")).rows[0].t,'Migración 107 ausente');
    for(const k of ['bot_whatsapp_solo_prueba','mesero_agente_v1','whatsapp_flows_v1','whatsapp_interactivos_v1','whatsapp_interactivos_elecciones_v1'])assert.equal(cfg[k],'true',k);
    assert.equal(Number(cfg.mesero_agente_porcentaje),0);assert.notEqual(cfg.mesero_agente_shadow,'true');
    assert.notEqual(cfg.whatsapp_catalogo_nativo_v1,'true','No sobrescribir un catálogo que alguien activó');
    assert.equal(cfg.whatsapp_flow_carrito_id,flowAnterior,'El Flow cambió: volver a revisar');
    for(const k of ['mesero_agente_telefonos','whatsapp_flows_telefonos']) {
      const lista=String(cfg[k] || '').split(/[,;\n]/).map(t=>t.trim()).filter(Boolean);
      assert(lista.length && lista.every(t=>normal(t)===telefono),'No ampliar el alcance');
    }
    const cambios={whatsapp_beta_hibrido_v1:'true',whatsapp_beta_telefonos:telefono,
      whatsapp_flow_carrito_id:flowId,whatsapp_flow_carrito_duplicar_v1:'true',whatsapp_catalogo_nativo_v1:'false'};
    for(const [clave,valor] of Object.entries(cambios))await db.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
      ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`,[negocioId,clave,valor]);
    await db.query('COMMIT');
    console.log(JSON.stringify({activada:true,cambios,alcance:'solo dueño',pedidos:'sin cambios',pausas:'sin cambios'}));
  } else await db.query('ROLLBACK');
} catch(e) {await db.query('ROLLBACK').catch(()=>{});throw e;}
finally{await db.end();}
