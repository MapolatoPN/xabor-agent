import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {inspeccionarEsquemaBasico,prepararEsquemaBasico,MIGRACIONES_BASICO} from '../scripts/lib-migraciones-basico.mjs';
const url=new URL(process.env.DATABASE_URL);
assert(['localhost','127.0.0.1'].includes(url.hostname));assert.match(url.pathname,/^\/test_basico_/);
assert.match(process.env.NODE_OPTIONS||'',/red-solo-local/);

test('predeploy Básico sobre producción simulada: autorización, atomicidad y conservación',async t=>{
  const nombre='test_basico_predeploy_'+randomUUID().replaceAll('-','').slice(0,12);
  assert.match(nombre,/^test_basico_predeploy_[a-f0-9]{12}$/);
  const admin=new pg.Pool({connectionString:url.toString()});let db,creada=false;
  try {
    await admin.query('CREATE DATABASE "'+nombre+'"');
    creada=true;
    const destino=new URL(url);destino.pathname='/'+nombre;
    const inicial=spawnSync(process.execPath,['test/preparar-basico-db.mjs'],{
      cwd:new URL('../',import.meta.url),env:{...process.env,DATABASE_URL:destino.toString(),XABOR_QA_HASTA_MIGRACION:'149'},encoding:'utf8',timeout:60000,
    });
    assert.equal(inicial.status,0,'Debe preparar la versión anterior, hasta la migración 149');
    db=new pg.Pool({connectionString:destino.toString()});
    const huella=async()=>(await db.query("SELECT md5(COALESCE(string_agg(row_to_json(n)::text,'' ORDER BY id),'')) AS h FROM negocios n")).rows[0].h;
    const antes=await huella();
    await t.test('sin autorización informa ausente y mantiene el esquema intacto',async()=>{
      assert.equal((await inspeccionarEsquemaBasico(db)).estado,'ausente');
      await assert.rejects(prepararEsquemaBasico(db),/Falta autorización/);
      assert.equal((await inspeccionarEsquemaBasico(db)).estado,'ausente');assert.equal(await huella(),antes);
    });
    await t.test('un fallo en la tercera migración revierte todas',async()=>{
      const defectuoso={connect:async()=>{
        const c=await db.connect();return {query:(sql,p)=>{
          if(sql.includes('ADD COLUMN IF NOT EXISTS id UUID'))throw Error('QA_FALLO_BASICO');
          return c.query(sql,p);
        },release:()=>c.release()};
      }};
      await assert.rejects(prepararEsquemaBasico(defectuoso,{autorizar:true}),/QA_FALLO_BASICO/);
      assert.equal((await inspeccionarEsquemaBasico(db)).estado,'ausente');assert.equal(await huella(),antes);
    });
    await t.test('con autorización prepara todas y valida aislamiento e importes',async()=>{
      assert.deepEqual((await prepararEsquemaBasico(db,{autorizar:true})).aplicadas,[...MIGRACIONES_BASICO]);
      assert.deepEqual(await inspeccionarEsquemaBasico(db),{estado:'completo',faltan:[]});
      assert.equal(await huella(),antes);
    });
    await t.test('repetir con datos ya guardados no los modifica',async()=>{
      await db.query(`INSERT INTO solicitudes_registro_basico(email,token_hash,password_hash,nombre_propietario,nombre_negocio,expires_at)
        VALUES('historial@ejemplo.invalid',$1,'QA_HASH_NO_USABLE','QA','QA',NOW()+INTERVAL '30 minutes')`,['0'.repeat(64)]);
      const huellaAlta=async()=>(await db.query("SELECT md5(row_to_json(s)::text) AS h FROM solicitudes_registro_basico s WHERE email='historial@ejemplo.invalid'")).rows[0].h;
      const altaAntes=await huellaAlta();
      assert.deepEqual((await prepararEsquemaBasico(db)).aplicadas,[]);
      assert.equal(await huellaAlta(),altaAntes);assert.equal(await huella(),antes);
    });
    await t.test('actualizar 150–154 conserva los datos y sigue exigiendo autorización',async()=>{
      await db.query('ALTER TABLE suscripciones_basico_mp DROP COLUMN correo_pagador CASCADE');
      for(const campo of ['cobro_sin_espera','condiciones_cobro_version','condiciones_cobro_aceptadas_at','solicitado_por_usuario_id','inicio_cobro_solicitado']){
        await db.query('ALTER TABLE suscripciones_basico_mp DROP COLUMN '+campo+' CASCADE');
      }
      assert.equal((await inspeccionarEsquemaBasico(db,{incluirPiloto:false,incluirCorreo:false})).estado,'completo');
      await assert.rejects(prepararEsquemaBasico(db),/Falta autorización/);
      const defectuoso={connect:async()=>{
        const c=await db.connect();return {query:(sql,p)=>c.query(sql.includes('ADD COLUMN IF NOT EXISTS cobro_sin_espera')?sql+';SELECT 1/0':sql,p),release:()=>c.release()};
      }};
      await assert.rejects(prepararEsquemaBasico(defectuoso,{autorizar:true}));
      assert.equal((await inspeccionarEsquemaBasico(db)).estado,'incompleto');assert.equal(await huella(),antes);
      assert.deepEqual((await prepararEsquemaBasico(db,{autorizar:true})).aplicadas,['155_basico_piloto_cobro_inicial.sql','156_basico_correo_pagador.sql']);
      assert.equal((await inspeccionarEsquemaBasico(db)).estado,'completo');
      assert.equal((await db.query('SELECT 1 FROM solicitudes_registro_basico')).rowCount,1);assert.equal(await huella(),antes);
    });
    await t.test('actualizar 150–155 agrega solo el correo sin inferir datos históricos',async()=>{
      await db.query('ALTER TABLE suscripciones_basico_mp DROP COLUMN correo_pagador CASCADE');
      const {rows:[historico]}=await db.query(`INSERT INTO suscripciones_basico_mp(negocio_id,external_reference,estado_mp,mensualidad)
        SELECT id,'xabor-basico:'||id::text,'canceled',150 FROM negocios ORDER BY id LIMIT 1 RETURNING id`);
      assert(historico,'Debe existir un contrato anterior para comprobar su conservación');
      const huellaContrato=async()=>(await db.query("SELECT md5((to_jsonb(c)-'correo_pagador')::text) AS h FROM suscripciones_basico_mp c WHERE id=$1",[historico.id])).rows[0].h;
      const contratoAntes=await huellaContrato();
      await assert.rejects(prepararEsquemaBasico(db),/Falta autorización/);
      const defectuoso={connect:async()=>{
        const c=await db.connect();return {query:(sql,p)=>c.query(sql.includes('ADD COLUMN IF NOT EXISTS correo_pagador')?sql+';SELECT 1/0':sql,p),release:()=>c.release()};
      }};
      await assert.rejects(prepararEsquemaBasico(defectuoso,{autorizar:true}));
      assert.equal((await inspeccionarEsquemaBasico(db,{incluirCorreo:false})).estado,'completo');
      assert.deepEqual((await prepararEsquemaBasico(db,{autorizar:true})).aplicadas,['156_basico_correo_pagador.sql']);
      assert.equal((await inspeccionarEsquemaBasico(db)).estado,'completo');
      assert.equal((await db.query('SELECT correo_pagador FROM suscripciones_basico_mp WHERE id=$1',[historico.id])).rows[0].correo_pagador,null);
      assert.equal(await huellaContrato(),contratoAntes);
      assert.equal((await db.query('SELECT 1 FROM solicitudes_registro_basico')).rowCount,1);assert.equal(await huella(),antes);
      assert.deepEqual((await prepararEsquemaBasico(db)).aplicadas,[]);
    });
    await t.test('una actualización parcial del correo no se repara sin revisión',async()=>{
      await db.query('ALTER TABLE suscripciones_basico_mp DROP CONSTRAINT basico_mp_correo_pagador');
      await assert.rejects(prepararEsquemaBasico(db,{autorizar:true}),/requiere revisión/);
      await db.query('ALTER TABLE suscripciones_basico_mp DROP COLUMN correo_pagador');
      await prepararEsquemaBasico(db,{autorizar:true});
    });
    await t.test('una actualización parcial del piloto no se repara sin revisión',async()=>{
      await db.query('ALTER TABLE suscripciones_basico_mp DROP COLUMN condiciones_cobro_version CASCADE');
      await assert.rejects(prepararEsquemaBasico(db,{autorizar:true}),/requiere revisión/);
      assert.equal((await db.query('SELECT 1 FROM solicitudes_registro_basico')).rowCount,1);
    });
    await t.test('un esquema parcial requiere revisión; no se repara silenciosamente',async()=>{
      await db.query('ALTER TABLE solicitudes_registro_basico DROP COLUMN privacidad_sha256');
      assert.equal((await inspeccionarEsquemaBasico(db)).estado,'incompleto');
      await assert.rejects(prepararEsquemaBasico(db,{autorizar:true}),/requiere revisión/);
      assert.equal((await db.query('SELECT 1 FROM solicitudes_registro_basico')).rowCount,1);assert.equal(await huella(),antes);
    });
  } finally {
    await db?.end();
    if(creada)await admin.query('DROP DATABASE "'+nombre+'"');await admin.end();
  }
});
