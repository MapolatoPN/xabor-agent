// Solo lo llama el inicializador con sus comprobaciones estrictas de entorno.
// No vuelve a ejecutar las migraciones históricas sobre el staging existente.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const MIGRACIONES_NUEVAS_STAGING_BASICO=Object.freeze([
  '144_superadmin_2fa.sql','145_limites_y_sesiones.sql',
  '146_aviso_promociones.sql','149_rewards_inscripcion.sql',
  '155_basico_piloto_cobro_inicial.sql',
]);

export async function actualizarStagingBasico(pool,{yaAplicadas=false}={}) {
  const client=await pool.connect();const aplicadas=[];
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('basico-staging-actualizaciones'))");
    await client.query(`CREATE TABLE IF NOT EXISTS basico_staging_migraciones(
      nombre TEXT PRIMARY KEY,sha256 CHAR(64) NOT NULL,aplicada_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for(const nombre of MIGRACIONES_NUEVAS_STAGING_BASICO) {
      const sql=readFileSync(new URL('../migrations/'+nombre,import.meta.url),'utf8');
      const sha=createHash('sha256').update(sql).digest('hex');
      const {rows:[existente]}=await client.query('SELECT sha256 FROM basico_staging_migraciones WHERE nombre=$1',[nombre]);
      if(existente){assert.equal(existente.sha256,sha,'Una migración registrada cambió; requiere revisión');continue;}
      if(!yaAplicadas) {
        let contenido=sql;
        if(nombre==='155_basico_piloto_cobro_inicial.sql'){
          const inicio=/^\s*BEGIN;\s*$/gmi,fin=/^\s*COMMIT;\s*$/gmi;
          assert.equal([...sql.matchAll(inicio)].length,1);assert.equal([...sql.matchAll(fin)].length,1);
          contenido=sql.replace(inicio,'').replace(fin,'');
        }
        assert(!/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(contenido),'La migración debe usar la transacción del inicializador');
        await client.query(contenido);
        aplicadas.push(nombre);
      }
      await client.query('INSERT INTO basico_staging_migraciones(nombre,sha256) VALUES($1,$2)',[nombre,sha]);
    }
    await client.query('COMMIT');return aplicadas;
  } catch(e) {await client.query('ROLLBACK');throw e;}
  finally {client.release();}
}
