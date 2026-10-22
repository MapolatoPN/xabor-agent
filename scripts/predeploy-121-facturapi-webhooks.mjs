import pg from 'pg';
import { readFile } from 'node:fs/promises';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host=new URL(process.env.DATABASE_URL).hostname;
const db=new pg.Client({connectionString:process.env.DATABASE_URL,
  ssl:['localhost','127.0.0.1','::1'].includes(host)?false:{rejectUnauthorized:false}});
try {
  await db.connect();await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-121-facturapi-webhooks',0))");
  await db.query(await readFile(new URL('../migrations/121_facturapi_webhooks.sql',import.meta.url),'utf8'));
  await db.query('SELECT negocio_id, routing_token, estado, secreto_cifrado, respaldo_pagina FROM facturapi_webhooks LIMIT 0');
  await db.query('SELECT negocio_id, evento_id, resultado FROM facturapi_webhook_eventos LIMIT 0');
  await db.query('COMMIT');console.log('[predeploy-121] Avisos de Facturapi: tablas listas y vacías; sin webhook registrado el barrido no cambia.');
} catch(e) {await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally {await db.end().catch(()=>{});}
