import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { pool } from '../src/services/database.js';
try {
  const {rows:[tabla]}=await pool.query("SELECT to_regclass('public.solicitudes_registro_basico') AS tabla");
  if(!tabla.tabla) {
    if(process.env.XABOR_ALTA_PUBLICA_PRO==='true')throw Error('Pro requiere el esquema de altas verificado');
  } else {
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='3s'");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('selfonboarding-163',0))");
      const {rows:[r]}=await db.query(`SELECT count(*)::int AS columnas FROM information_schema.columns WHERE table_schema='public'
        AND table_name='solicitudes_registro_basico' AND column_name IN ('plan_solicitado','dias_prueba','mensualidad_solicitada')`);
      if(r.columnas!==3) {
        if(r.columnas!==0)throw Error('Migración de autoservicio parcial; requiere revisión');
        if(process.env.XABOR_MIGRAR_BASICO!=='SI')throw Error('Falta autorización para preparar el autoservicio');
        await db.query(readFileSync(new URL('../migrations/163_selfonboarding_planes.sql',import.meta.url),'utf8'));
      }
      const {rows:[regla]}=await db.query("SELECT pg_get_constraintdef(oid) AS regla FROM pg_constraint WHERE conrelid='suscripciones_basico_mp'::regclass AND conname='mp_basico_referencia' AND convalidated");
      if(!regla?.regla.includes('xabor-pro:'))throw Error('Falta la referencia de suscripción Pro');
      await db.query('COMMIT');
    } catch(e){await db.query('ROLLBACK');throw e;} finally{db.release();}
  }
  console.log('[predeploy-163] Autoservicio listo; no se modificaron negocios ni contratos existentes.');
}catch(e){console.error('[predeploy-163] '+e.message);process.exitCode=1;}
finally{await pool.end();}
