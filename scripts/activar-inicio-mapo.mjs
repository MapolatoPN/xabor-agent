// Operación explícita del dueño. No envía mensajes, no levanta pausas y no
// enciende otros negocios. Ejecutar solo sobre el SHA revisado y desplegado.
import assert from 'node:assert/strict';
import { pool } from '../src/services/database.js';
import { credencialFlows,clienteMetaFlows } from './lib-meta-flows.mjs';
import { enElCanario } from '../src/orders/modoDelPedido.js';
import { flowsActivos } from '../src/mesero-agente/formularioAgrupado.js';
import { betaHibridaActiva } from '../src/mesero-agente/experienciaHibrida.js';
const [negocioId,sha,modo]=process.argv.slice(2);
assert.equal(negocioId,'5de544d8-9a0a-4972-9c92-fd48ff22de66');
assert.match(sha || '',/^[a-f0-9]{40}$/);
assert.equal(process.env.RAILWAY_GIT_COMMIT_SHA,sha,'Build distinto al revisado');
assert(['activar','revertir'].includes(modo));
const claveRespaldo='whatsapp_inicio_mapo_respaldo_20260930';
const cambios={whatsapp_inicio_mapo_v1:'true',whatsapp_atencion_general_v1:'true',
  bot_whatsapp_solo_prueba:'false',mesero_agente_porcentaje:'100',mesero_agente_telefonos:'',
  whatsapp_flow_facturacion_id:'1465791332088956',whatsapp_flow_evento_id:'957762156770578'};
let tx;
try {
  tx=await pool.connect();await tx.query('BEGIN');
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('activar-inicio-mapo:' || $1,0))",[negocioId]);
  const {rows:[n]}=await tx.query('SELECT slug,bot_whatsapp_activo FROM negocios WHERE id=$1 FOR UPDATE',[negocioId]);
  assert.equal(n?.slug,'mapolato-obispado');
  const cfg=Object.fromEntries((await tx.query('SELECT clave,valor FROM configuracion WHERE negocio_id=$1 FOR UPDATE',[negocioId])).rows.map(r=>[r.clave,r.valor]));
  const respaldo=cfg[claveRespaldo]?JSON.parse(cfg[claveRespaldo]):null;
  let aplicar;
  if(modo==='activar') {
    assert.equal(n.bot_whatsapp_activo,true,'El corte maestro está apagado');
    for(const k of ['MESERO_AGENTE_MODE','WHATSAPP_INTERACTIVOS','WHATSAPP_FLOW_ENDPOINT'])assert.equal(process.env[k],'true',k);
    assert(process.env.WHATSAPP_FLOW_PRIVATE_KEY && process.env.META_APP_SECRET);
    for(const k of ['mesero_agente_v1','whatsapp_interactivos_v1','whatsapp_interactivos_elecciones_v1','whatsapp_flows_v1','whatsapp_beta_hibrido_v1'])assert.equal(cfg[k],'true',k);
    assert.equal(cfg.mesero_agente_shadow,'false');
    assert.equal((await tx.query("SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='whatsapp'",[negocioId])).rows[0]?.estado,'activo');
    assert((await tx.query("SELECT to_regclass('agente_solicitudes_servicio') AS tabla")).rows[0].tabla);
    const cred=await credencialFlows(negocioId),api=clienteMetaFlows(cred.token);
    const flows=await api(`${cred.wabaId}/flows?fields=id,status,validation_errors&limit=100`);
    for(const id of [cfg.whatsapp_flow_categorias_id,cfg.whatsapp_flow_carrito_id,...Object.values(cambios).filter(v=>/^\d{10,30}$/.test(v))]) {
      const f=flows.data.find(x=>x.id===id);assert.equal(f?.status,'PUBLISHED',`Flow ${id} no publicado`);
      assert(!f.validation_errors?.length);
    }
    const siguiente={...cfg,...cambios};
    assert(enElCanario('528700000000',{lista:siguiente.mesero_agente_telefonos,porcentaje:siguiente.mesero_agente_porcentaje}).dentro);
    assert(flowsActivos(siguiente,'528700000000') && betaHibridaActiva(siguiente,'528700000000'));
    if(respaldo)assert(Object.entries(cambios).every(([k,v])=>cfg[k]===v),'Ya existe respaldo; revisar cambios posteriores antes de reactivar');
    else {
      assert.equal(cfg.bot_whatsapp_solo_prueba,'true');assert.equal(cfg.mesero_agente_porcentaje,'0');
      assert.equal(cfg.mesero_agente_telefonos,'528787899919,5218787899919');
      const antes=Object.fromEntries(Object.keys(cambios).map(k=>[k,cfg[k]??null]));
      await tx.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)',
        [negocioId,claveRespaldo,JSON.stringify({build:sha,fecha:new Date().toISOString(),antes,despues:cambios})]);
    }
    aplicar=cambios;
  } else {
    assert(respaldo,'Sin respaldo no se revierte');
    assert(Object.entries(respaldo.despues).every(([k,v])=>cfg[k]===v),'La configuración cambió después: no sobrescribir');
    aplicar=respaldo.antes;
  }
  for(const [k,v] of Object.entries(aplicar)) {
    if(v===null)await tx.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2',[negocioId,k]);
    else await tx.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3) ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor',[negocioId,k,v]);
  }
  await tx.query('COMMIT');
  console.log(JSON.stringify({modo,negocioId,build:sha,cambios:aplicar,pausas:'intactas',envios:0}));
} catch(e) {await tx?.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally {tx?.release();await pool.end();}
