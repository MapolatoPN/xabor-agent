// Informe agregado, exclusivamente SELECT. No carga servidor ni transporte.
import pg from 'pg';
import { consultarEmbudoFormularios } from '../src/services/embudoFormularios.js';
const args=process.argv.slice(2),valor=k=>args[args.indexOf(k)+1];
if(!['--negocio','--desde','--hasta'].every(k=>args.includes(k)))throw Error('Uso: node scripts/analizar-formularios.mjs --negocio slug --desde YYYY-MM-DD --hasta YYYY-MM-DD (exclusivo)');
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},options:'-c default_transaction_read_only=on'});
try {await db.connect();console.log(JSON.stringify(await consultarEmbudoFormularios(db,{slug:valor('--negocio'),desde:valor('--desde'),hasta:valor('--hasta')}),null,2));}
finally {await db.end();}
