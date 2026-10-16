// Postgres local: reservas y activos ficticios. Ninguna llamada a proveedores.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {consultarAgendaProgramados} from '../src/services/agendaProgramados.js';
import {programadoParaConsulta} from '../src/services/programadosConsulta.js';
const url=new URL(process.env.DATABASE_URL);
assert(['127.0.0.1','localhost'].includes(url.hostname));assert.match(url.pathname,/^\/test_botones_programados_/);assert.match(process.env.NODE_OPTIONS||'',/red-solo-local/);
const db=new pg.Client({connectionString:url.href,ssl:{rejectUnauthorized:false}});
let n=0;const caso=async(nombre,fn)=>{await fn();console.log(`OK agenda DB ${++n}: ${nombre}`);};
try{
 await db.connect();await db.query('BEGIN');
 const ids=[randomUUID(),randomUUID()],folios=['XAB-LOCAL-'+randomUUID().slice(0,7),'XAB-LOCAL-'+randomUUID().slice(0,7)];
 const para='2026-10-30T13:00:00.000Z';
 for(let i=0;i<2;i++){
  await db.query('INSERT INTO negocios(id,nombre,slug,activo) VALUES($1,$2,$3,true)',[ids[i],'Agenda local '+i,'agenda-'+ids[i]]);
  const datos={negocioId:ids[i],estado:'pendiente_pago',programado_para:para,programado_id:randomUUID(),forma_pago:'enlace_pago',pago_confirmado:false,total:200,cliente:{nombre:'Cliente ficticio'}};
  await db.query('INSERT INTO pedidos_programados(folio,negocio_id,programado_id,datos,programado_para,activado) VALUES($1,$2,$3,$4,$5,false)',[folios[i],ids[i],datos.programado_id,datos,para]);
 }
 const snapshot=async()=>({reservas:(await db.query('SELECT folio,datos,activado FROM pedidos_programados WHERE negocio_id=ANY($1) ORDER BY folio',[ids])).rows,activos:(await db.query('SELECT folio,datos,estado FROM pedidos_activos WHERE negocio_id=ANY($1) ORDER BY folio',[ids])).rows,trabajos:(await db.query('SELECT count(*)::int n FROM impresion_trabajos WHERE negocio_id=ANY($1)',[ids])).rows[0].n,pagos:(await db.query('SELECT count(*)::int n FROM pagos WHERE negocio_id=ANY($1)',[ids])).rows[0].n});
 await caso('visible desde la reserva, incluso antes del pago; otro negocio permanece aislado',async()=>{
  for(let i=0;i<2;i++){const a=await consultarAgendaProgramados(db,ids[i]);assert.equal(a.length,1);assert.equal(a[0].folio,folios[i]);assert.equal(a[0].activado,false);assert.equal(programadoParaConsulta(a[0]).estado_pago,'pendiente');}
 });
 await caso('sin negocio no consulta ni devuelve una agenda global',async()=>{assert.deepEqual(await consultarAgendaProgramados({query:()=>{throw Error('No debe consultar');}},null),[]);});
 await db.query("UPDATE pedidos_programados SET datos=datos||'{\"estado\":\"nuevo\",\"pago_confirmado\":true}'::jsonb WHERE folio=$1",[folios[0]]);
 const r=(await db.query('SELECT * FROM pedidos_programados WHERE folio=$1',[folios[0]])).rows[0];
 await db.query("INSERT INTO pedidos_activos(folio,negocio_id,estado,datos) VALUES($1,$2,'en_preparacion',$3)",[folios[0],ids[0],{...r.datos,estado:'en_preparacion',total:250}]);
 await caso('la transición no duplica tarjetas; el activo aporta estado y total actuales',async()=>{
  const a=await consultarAgendaProgramados(db,ids[0]);assert.equal(a.length,1);assert.equal(a[0].estado,'en_preparacion');assert.equal(a[0].datos.total,250);assert.equal(a[0].activado,false);
 });
 await db.query('UPDATE pedidos_programados SET activado=true WHERE folio=$1',[folios[0]]);
 await caso('activar no hace desaparecer el pedido de la agenda',async()=>{
  const a=await consultarAgendaProgramados(db,ids[0]);assert.equal(a.length,1);assert.equal(a[0].activado,true);assert.equal(programadoParaConsulta(a[0]).estado_operativo,'en_preparacion');
 });
 await caso('consultar no paga, activa, imprime ni cambia pedidos',async()=>{const antes=await snapshot();await consultarAgendaProgramados(db,ids[0]);await consultarAgendaProgramados(db,ids[1]);assert.deepEqual(await snapshot(),antes);});
 for(const estado of ['entregado','cancelado']){
  await db.query('UPDATE pedidos_activos SET estado=$2::text,datos=datos||jsonb_build_object(\'estado\',$2::text) WHERE folio=$1',[folios[0],estado]);
  await caso('retira de agenda el pedido '+estado,async()=>assert.equal((await consultarAgendaProgramados(db,ids[0])).length,0));
 }
}finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
console.log(`Agenda de programados DB: ${n} grupos correctos.`);
