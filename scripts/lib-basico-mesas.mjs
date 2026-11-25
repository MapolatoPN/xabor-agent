import {readFileSync} from 'node:fs';
const PENDIENTES=`SELECT COUNT(DISTINCT s.negocio_id)::int AS n FROM solicitudes_registro_basico s
 JOIN negocio_plan_comercial pc ON pc.negocio_id=s.negocio_id
 LEFT JOIN negocio_modulos m ON m.negocio_id=s.negocio_id AND m.modulo='restaurante'
 WHERE s.used_at IS NOT NULL AND pc.plan='basico' AND pc.mensualidad=150
 AND (m.id IS NULL OR m.estado IN ('no_configurado','no_contratado'))`;
export async function prepararMesasBasico(pool,{autorizar=false,comprobar=false}={}){
 const c=await pool.connect();
 try{
  await c.query(comprobar?'BEGIN TRANSACTION READ ONLY':'BEGIN');
  if(!comprobar)await c.query("SELECT pg_advisory_xact_lock(hashtext('xabor-basico-mesas'))");
  const {rows:[tablas]}=await c.query("SELECT to_regclass('public.solicitudes_registro_basico') AS altas");
  if(!tablas.altas){await c.query('COMMIT');return {pendientes:0,actualizados:0};}
  const {rows:[antes]}=await c.query(PENDIENTES);
  if(comprobar||!antes.n){await c.query('COMMIT');return {pendientes:antes.n,actualizados:0};}
  if(!autorizar)throw Error('Falta autorización para incluir mesas en las cuentas Básico existentes');
  const sql=readFileSync(new URL('../migrations/161_basico_mesas_incluidas.sql',import.meta.url),'utf8').replace(/^\s*(BEGIN|COMMIT);\s*$/gm,'');
  await c.query(sql);
  const {rows:[despues]}=await c.query(PENDIENTES);if(despues.n)throw Error('No se pudieron completar las mesas del Básico');
  await c.query('COMMIT');return {pendientes:0,actualizados:antes.n};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
