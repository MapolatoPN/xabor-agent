// Una sola transacción, con lock para deploys concurrentes. Solo toca Compras.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL es requerida');
const db = new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
try {
  await db.connect(); await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migraciones-compras-069-070',0))");
  for (const file of ['069_compras_operativas.sql','070_compras_pagos_fondos.sql']) {
    await db.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  }
  for (const table of ['compras_operativas','compras_operativas_items','fondos_compras','compras_responsables','compras_pagos']) {
    await db.query(`SELECT 1 FROM ${table} LIMIT 0`);
  }
  await db.query('SELECT version,pagos_revisados FROM compras_operativas LIMIT 0');
  await db.query('COMMIT'); console.log('[compras] Migraciones 069 y 070 verificadas.');
} catch(e) {
  await db.query('ROLLBACK').catch(()=>{});console.error('[compras] Falló la migración:',e.message);process.exitCode=1;
} finally {await db.end();}
