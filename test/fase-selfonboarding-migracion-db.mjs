import './entorno-superadmin-local.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pool} from '../src/services/database.js';
after(()=>pool.end());
test('163 sobre esquema anterior: preserva solicitud, contrato, precio y fechas; reaplicación idempotente y restricciones efectivas',async()=>{
  const db=await pool.connect(),schema='qa_onboarding_'+randomUUID().replaceAll('-','');
  try{
    await db.query('BEGIN');await db.query('CREATE SCHEMA '+schema);await db.query('SET LOCAL search_path TO '+schema);
    await db.query(`CREATE TABLE solicitudes_registro_basico(id uuid PRIMARY KEY,email text,used_at timestamptz,negocio_id uuid);
      CREATE TABLE suscripciones_basico_mp(negocio_id uuid,external_reference text,mensualidad numeric,
        CONSTRAINT mp_basico_referencia CHECK(external_reference='xabor-basico:'||negocio_id::text))`);
    const nid=randomUUID();
    await db.query("INSERT INTO solicitudes_registro_basico VALUES($1,'anterior@ejemplo.invalid',NOW()-INTERVAL '3 days',$2)",[randomUUID(),nid]);
    await db.query("INSERT INTO suscripciones_basico_mp VALUES($1::uuid,'xabor-basico:'||$1::uuid::text,175)",[nid]);
    const antes=(await db.query('SELECT * FROM solicitudes_registro_basico')).rows[0];
    const contrato=(await db.query('SELECT * FROM suscripciones_basico_mp')).rows[0];
    const sql=readFileSync(new URL('../migrations/163_selfonboarding_planes.sql',import.meta.url),'utf8');
    for(let i=0;i<2;i++){
      await db.query(sql);
      const {plan_solicitado,dias_prueba,mensualidad_solicitada,...despues}=(await db.query('SELECT * FROM solicitudes_registro_basico')).rows[0];
      assert.deepEqual(despues,antes);assert.equal(plan_solicitado,'basico');assert.equal(dias_prueba,7);assert.equal(mensualidad_solicitada,null);
      assert.deepEqual((await db.query('SELECT * FROM suscripciones_basico_mp')).rows[0],contrato);
    }
    await db.query("INSERT INTO suscripciones_basico_mp VALUES($1::uuid,'xabor-pro:'||$1::uuid::text,900)",[randomUUID()]);
    for(const cambio of ["plan_solicitado='superadmin'","dias_prueba=90","mensualidad_solicitada=0"]){
      await db.query('SAVEPOINT intento');
      await assert.rejects(db.query('UPDATE solicitudes_registro_basico SET '+cambio),e=>e.code==='23514');
      await db.query('ROLLBACK TO SAVEPOINT intento');
    }
  }finally{await db.query('ROLLBACK');db.release();}
});
