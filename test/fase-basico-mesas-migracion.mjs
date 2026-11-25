import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {prepararMesasBasico} from '../scripts/lib-basico-mesas.mjs';
const url=new URL(process.env.DATABASE_URL);
assert(['localhost','127.0.0.1'].includes(url.hostname));
assert.match(url.pathname,/^\/test_basico_/);
assert.match(process.env.NODE_OPTIONS||'',/red-solo-local/);

test('Mesas Básico: actualización autorizada, acotada e idempotente',async()=>{
  const db=new pg.Pool({connectionString:url.toString()});
  const ids=[];
  try{
    const casos=[
      ['no_configurado',150,true,true], [null,150,true,true],
      ['activo',150,true,true], ['configurado',150,true,true],
      ['pendiente',150,true,true], ['suspendido',150,true,true],
      ['no_configurado',900,true,true], ['no_configurado',150,false,true],
      ['no_configurado',150,true,false],
    ];
    for(const [estado,monto,verificado,alta] of casos){
      const id=randomUUID();ids.push(id);
      await db.query("INSERT INTO negocios(id,nombre,slug) VALUES($1,'QA mesas',$2)",[id,'qa-mesas-'+id]);
      await db.query("INSERT INTO negocio_plan_comercial(negocio_id,plan,mensualidad) VALUES($1,'basico',$2)",[id,monto]);
      if(estado)await db.query("INSERT INTO negocio_modulos(negocio_id,modulo,estado) VALUES($1,'restaurante',$2)",[id,estado]);
      if(alta)await db.query(`INSERT INTO solicitudes_registro_basico(email,token_hash,password_hash,nombre_propietario,nombre_negocio,expires_at,used_at,negocio_id)
        VALUES($1,$2,'QA_NO_CREDENCIAL','QA','QA',NOW()+INTERVAL '1 hour',CASE WHEN $3 THEN NOW() ELSE NULL END,$4)`,
        ['qa-'+id+'@ejemplo.invalid',id.replaceAll('-','').repeat(2),verificado,id]);
    }
    const modulos=async()=>(await db.query("SELECT negocio_id,estado,updated_at FROM negocio_modulos WHERE negocio_id=ANY($1::uuid[]) AND modulo='restaurante' ORDER BY negocio_id",[ids])).rows;
    const huella=async()=>(await db.query(`SELECT md5(jsonb_build_object(
      'negocios',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM negocios n WHERE id=ANY($1::uuid[])),
      'planes',(SELECT jsonb_agg(to_jsonb(p) ORDER BY negocio_id) FROM negocio_plan_comercial p WHERE negocio_id=ANY($1::uuid[])),
      'altas',(SELECT jsonb_agg(to_jsonb(s) ORDER BY negocio_id) FROM solicitudes_registro_basico s WHERE negocio_id=ANY($1::uuid[])))::text) AS h`,[ids])).rows[0].h;
    const antes=await modulos(),datosAntes=await huella();
    assert.deepEqual(await prepararMesasBasico(db,{comprobar:true}),{pendientes:2,actualizados:0});
    await assert.rejects(prepararMesasBasico(db),/Falta autorización/);
    assert.deepEqual(await modulos(),antes);
    const defectuoso={connect:async()=>{
      const c=await db.connect();return {release:()=>c.release(),query:async(sql,p)=>{
        const r=await c.query(sql,p);
        if(sql.includes('INSERT INTO negocio_modulos'))throw Error('QA_FALLO_TRAS_ACTUALIZAR_MESAS');
        return r;
      }};
    }};
    await assert.rejects(prepararMesasBasico(defectuoso,{autorizar:true}),/QA_FALLO/);
    assert.deepEqual(await modulos(),antes);
    assert.deepEqual(await prepararMesasBasico(db,{autorizar:true}),{pendientes:0,actualizados:2});
    const despues=await modulos();
    for(const id of ids.slice(0,2))assert.equal(despues.find(m=>m.negocio_id===id).estado,'activo');
    assert.deepEqual(despues.filter(m=>!ids.slice(0,2).includes(m.negocio_id)),antes.filter(m=>!ids.slice(0,2).includes(m.negocio_id)));
    assert.equal(await huella(),datosAntes,'No cambia negocios, precios, altas ni consentimientos');
    assert.deepEqual(await prepararMesasBasico(db),{pendientes:0,actualizados:0});
    assert.deepEqual(await modulos(),despues);
  }finally{
    // Solo las identidades sintéticas de esta ejecución, en PostgreSQL local.
    await db.query('DELETE FROM solicitudes_registro_basico WHERE negocio_id=ANY($1::uuid[])',[ids]);
    await db.query('DELETE FROM negocio_modulos WHERE negocio_id=ANY($1::uuid[])',[ids]);
    await db.query('DELETE FROM negocio_plan_comercial WHERE negocio_id=ANY($1::uuid[])',[ids]);
    await db.query('DELETE FROM negocios WHERE id=ANY($1::uuid[])',[ids]);
    await db.end();
  }
});
