// Solo SELECT en transacción READ ONLY. No importa server ni módulos de envío.
import pg from 'pg';
import { consultarEmbudo } from '../src/services/embudoConversaciones.js';
const args = process.argv.slice(2);
const valor = k => args[args.indexOf(k)+1];
if (!args.includes('--negocio') || !args.includes('--desde') || !args.includes('--hasta')) {
  throw Error('Uso: node scripts/analizar-conversaciones.mjs --negocio slug --desde YYYY-MM-DD --hasta YYYY-MM-DD (exclusivo)');
}
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const db = new pg.Client({ connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},
  options:'-c default_transaction_read_only=on',connectionTimeoutMillis:15000 });
try {
  await db.connect();
  console.log(JSON.stringify(await consultarEmbudo(db,{slug:valor('--negocio'),desde:valor('--desde'),hasta:valor('--hasta')}),null,2));
} finally { await db.end(); }
