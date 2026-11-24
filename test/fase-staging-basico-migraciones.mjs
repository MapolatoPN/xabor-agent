import test from 'node:test';
import assert from 'node:assert/strict';
import {actualizarStagingBasico,MIGRACIONES_NUEVAS_STAGING_BASICO} from '../scripts/lib-actualizar-staging-basico.mjs';
const db=new URL(process.env.DATABASE_URL);
assert(['127.0.0.1','localhost'].includes(db.hostname));assert.match(db.pathname,/^\/test_basico_/);
const {pool}=await import('../src/services/database.js');

test('actualización de staging: atómica, repetible y con huella de cada SQL',async t=>{
  try {
    const tabla=async()=>(await pool.query("SELECT to_regclass('public.basico_staging_migraciones') AS t")).rows[0].t;
    assert.equal(await tabla(),null,'Esta suite requiere una base de pruebas nueva');
    const antes=(await pool.query('SELECT COUNT(*)::int AS n FROM negocios')).rows[0].n;
    await t.test('un fallo intermedio revierte también el registro de versiones',async()=>{
      const defectuoso={connect:async()=>{
        const c=await pool.connect();return {
          query:(sql,params)=>{
            if(sql.includes('CREATE TABLE IF NOT EXISTS limites_acceso'))throw Error('QA_FALLO_UPGRADE');
            return c.query(sql,params);
          },release:()=>c.release(),
        };
      }};
      await assert.rejects(actualizarStagingBasico(defectuoso),/QA_FALLO_UPGRADE/);
      assert.equal(await tabla(),null);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM negocios')).rows[0].n,antes);
    });
    await t.test('aplica las pendientes; una repetición no vuelve a ejecutarlas',async()=>{
      assert.deepEqual(await actualizarStagingBasico(pool),[...MIGRACIONES_NUEVAS_STAGING_BASICO]);
      assert.deepEqual(await actualizarStagingBasico(pool),[]);
      assert.equal((await pool.query('SELECT 1 FROM basico_staging_migraciones')).rowCount,MIGRACIONES_NUEVAS_STAGING_BASICO.length);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM negocios')).rows[0].n,antes);
    });
    await t.test('un SQL distinto del registrado requiere revisión',async()=>{
      const nombre=MIGRACIONES_NUEVAS_STAGING_BASICO[0];
      const {rows:[original]}=await pool.query('SELECT sha256 FROM basico_staging_migraciones WHERE nombre=$1',[nombre]);
      await pool.query('UPDATE basico_staging_migraciones SET sha256=$2 WHERE nombre=$1',[nombre,'0'.repeat(64)]);
      try {await assert.rejects(actualizarStagingBasico(pool),/requiere revisión/);}
      finally {await pool.query('UPDATE basico_staging_migraciones SET sha256=$2 WHERE nombre=$1',[nombre,original.sha256]);}
    });
  } finally {await pool.end();}
});
