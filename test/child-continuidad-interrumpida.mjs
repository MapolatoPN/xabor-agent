import pg from 'pg';
import {crearContinuidad} from '../src/services/whatsappContinuidad.js';
if(!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname))throw Error('Solo local');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const locks=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const [n,t]=process.argv.slice(2);
const c=crearContinuidad({pool,locks,ventanaMs:0,cargarSesion:()=>{},leerSesion:()=>null,
 procesar:async()=>{
  await pool.query("INSERT INTO mensajes(negocio_id,telefono,direccion,texto,origen) VALUES($1,$2,'saliente','EFECTO-INTERRUMPIDO','bot')",[n,t]);
  console.log('EFECTO_HECHO');
  await new Promise(()=>{setInterval(()=>{},1000);});
 }});
await c.ejecutar(n,t);
