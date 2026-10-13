// Base LOCAL exclusivamente; esquema efímero aislado. Ningún envío real.
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buscarPendientesAtencion,reclamarRecordatorio,siguePendiente,revisarAtencionPendiente } from '../src/services/seguimientoAtencion.js';
import { consultarEmbudo } from '../src/services/embudoConversaciones.js';
const url=process.env.DATABASE_URL;
if (!url || !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) throw Error('Solo PostgreSQL LOCAL autorizado para esta prueba');
const db=new pg.Client({connectionString:url,ssl:{rejectUnauthorized:false}});
const otro=new pg.Client({connectionString:url,ssl:{rejectUnauthorized:false}});
const esquema=`qa_atencion_${randomUUID().replaceAll('-','')}`;
const neg=randomUUID(),neg2=randomUUID(),tel='5218781111111';
let n=0;
const caso=async(nombre,fn)=>{await fn();n++;console.log(`OK ${nombre}`);};
try {
  await db.connect();await otro.connect();
  await db.query(`CREATE SCHEMA ${esquema}`);
  for(const c of [db,otro]) await c.query(`SET search_path TO ${esquema}`);
  await db.query(`CREATE TABLE negocios(id uuid PRIMARY KEY,nombre text,slug text);
    CREATE TABLE configuracion(negocio_id uuid,clave text,valor text);
    CREATE TABLE mensajes(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,negocio_id uuid,telefono text,
      direccion text,origen text,texto text,timestamp timestamp,message_id_externo text);
    CREATE TABLE whatsapp_conversaciones(negocio_id uuid,telefono text,motivo text,requiere_revision boolean);
    CREATE TABLE pedidos_activos(folio text,negocio_id uuid,estado text,datos jsonb,created_at timestamp);
    CREATE TABLE agente_turnos(negocio_id uuid,wamids text[],motivo_handoff text,modo text,created_at timestamptz);`);
  await db.query(await readFile(new URL('../migrations/116_conversaciones_atencion_avisos.sql',import.meta.url),'utf8'));
  await db.query('INSERT INTO negocios VALUES($1,$2,$3),($4,$5,$6)',[neg,'Local','local',neg2,'Otro','otro']);
  const horarios=Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
    .map(d=>[d,{abierto:true,apertura:'00:00',cierre:'24:00'}]));
  for(const [clave,valor] of Object.entries({whatsapp_seguimiento_atencion_v1:'true',
    whatsapp_seguimiento_atencion_desde:new Date(Date.now()-86400000).toISOString(),timezone:'America/Matamoros',
    reglas_atencion:JSON.stringify({horarios})})) await db.query('INSERT INTO configuracion VALUES($1,$2,$3)',[neg,clave,valor]);
  await db.query('INSERT INTO whatsapp_conversaciones VALUES($1,$2,$3,true)',[neg,tel,'RECEPCION_PIDE_PERSONA']);
  const insertar=async(n,t,origen,texto,ts='now() AT TIME ZONE \'UTC\'')=>(await db.query(`INSERT INTO mensajes
    (negocio_id,telefono,direccion,origen,texto,timestamp) VALUES($1,$2,$3,$4,$5,${ts}) RETURNING id`,
    [n,t,origen==='cliente'?'entrante':'saliente',origen,texto])).rows[0].id;
  const ancla=await insertar(neg,tel,'cliente','Los hotcakes olían feo como a pescado');
  await insertar(neg2,tel,'humano','Respuesta de OTRO negocio');
  let fila;
  await caso('consulta respeta negocio: humano de otro negocio no oculta una queja',async()=>{
    [fila]=await buscarPendientesAtencion(db);assert.equal(fila.negocio_id,neg);assert.equal(fila.mensaje_id,ancla);
    assert.equal(await siguePendiente(db,fila),true);
  });
  await caso('dos procesos compiten y solo uno reclama el mismo aviso',async()=>{
    const ids=await Promise.all([reclamarRecordatorio(db,fila,{fase:'abierto',prioridad:'urgente'}),
      reclamarRecordatorio(otro,fila,{fase:'abierto',prioridad:'urgente'})]);
    assert.equal(ids.filter(Boolean).length,1);
    await db.query('UPDATE conversaciones_atencion_avisos SET lease_hasta=now()-interval \'1 second\'');
  });
  await caso('aviso confirmado queda durable y no se repite tras otro proceso',async()=>{
    const eventos=[];
    assert.equal(await revisarAtencionPendiente({db,broadcastPanel:(n,d)=>eventos.push({n,d})}),1);
    assert.equal(await revisarAtencionPendiente({db:otro,broadcastPanel:()=>assert.fail('duplicado')}),0);
    assert.equal(eventos[0].d.prioridad,'urgente');
  });
  await caso('avisar fuera de horario y al abrir son fases distintas',async()=>{
    assert(await reclamarRecordatorio(db,fila,{fase:'cerrado',prioridad:'urgente'}));
  });
  await caso('respuesta humana posterior cierra el pendiente sin tocar la pausa',async()=>{
    await insertar(neg,tel,'humano','Atendido');
    assert.equal(await siguePendiente(db,fila),false);assert.deepEqual(await buscarPendientesAtencion(db),[]);
    const {rows:[r]}=await db.query('SELECT requiere_revision FROM whatsapp_conversaciones');assert(r.requiere_revision);
  });
  await caso('regreso del cliente crea un episodio nuevo; reintento tras fallo de aviso',async()=>{
    await insertar(neg,tel,'cliente','Los hotcakes olían feo otra vez');
    const logs=[];
    await revisarAtencionPendiente({db,broadcastPanel:()=>{throw Error('fallo simulado');},log:s=>logs.push(s)});
    assert(logs.some(s=>/reintento/.test(s)));
    assert.equal(await revisarAtencionPendiente({db,broadcastPanel:()=>{}}),1);
  });
  await caso('pendiente revisado en panel ya no se busca',async()=>{
    await db.query('UPDATE whatsapp_conversaciones SET requiere_revision=false');
    assert.deepEqual(await buscarPendientesAtencion(db),[]);
  });
  await caso('fecha de activación malformada no tumba el barrido',async()=>{
    await db.query('UPDATE whatsapp_conversaciones SET requiere_revision=true');
    await db.query("UPDATE configuracion SET valor='2026-99-88T25:00:00Z' WHERE clave='whatsapp_seguimiento_atencion_desde'");
    assert.deepEqual(await buscarPendientesAtencion(db),[]);
  });
  await caso('más de 100 pendientes no ocultan al último; apagar bandera cancela envío en curso',async()=>{
    await db.query("UPDATE configuracion SET valor=$1 WHERE clave='whatsapp_seguimiento_atencion_desde'",[new Date(Date.now()-86400000).toISOString()]);
    await db.query(`INSERT INTO whatsapp_conversaciones SELECT $1,'qa-'||i,'RECEPCION_PIDE_PERSONA',true FROM generate_series(1,101) i`,[neg]);
    await db.query(`INSERT INTO mensajes(negocio_id,telefono,direccion,origen,texto,timestamp)
      SELECT $1,'qa-'||i,'entrante','cliente','Hola',now() AT TIME ZONE 'UTC' FROM generate_series(1,101) i`,[neg]);
    const filas=await buscarPendientesAtencion(db);
    const ultima=filas.find(f=>f.telefono==='qa-101');assert(ultima);assert(filas.length>100);
    assert.equal(await siguePendiente(db,ultima),true);
    await db.query("UPDATE configuracion SET valor='false' WHERE clave='whatsapp_seguimiento_atencion_v1'");
    assert.equal(await siguePendiente(db,ultima),false);assert.deepEqual(await buscarPendientesAtencion(db),[]);
  });
  await caso('embudo usa fecha local, excluye límite final y no mezcla negocios',async()=>{
    await db.query('DELETE FROM conversaciones_atencion_avisos');await db.query('DELETE FROM mensajes');
    await insertar(neg,tel,'cliente','Fuera del periodo',"'2026-10-10 04:59:59'::timestamp");
    const id=await insertar(neg,tel,'cliente','Formulario recibido · pendiente de validación',"'2026-10-10 05:00:00'::timestamp");
    await db.query("UPDATE mensajes SET message_id_externo='wamid.qa' WHERE id=$1",[id]);
    await insertar(neg,tel,'bot','Tu pedido XAB-1 quedó registrado',"'2026-10-10 05:01:00'::timestamp");
    await insertar(neg,tel,'humano','Revisado',"'2026-10-11 04:59:59'::timestamp");
    await insertar(neg,'8782222222','cliente','Consulta',"'2026-10-11 05:00:00'::timestamp");
    await insertar(neg,tel,'cliente','Límite final fuera',"'2026-10-12 05:00:00'::timestamp");
    await insertar(neg2,tel,'cliente','Otro negocio',"'2026-10-10 05:00:00'::timestamp");
    await db.query(`INSERT INTO pedidos_activos VALUES('XAB-1',$1,'entregado',
      '{"canal":"whatsapp","cliente":{"telefono":"8781111111"}}','2026-10-10 05:01:00'),
      ('XAB-2',$1,'entregado','{"canal":"tienda_online","cliente":{"telefono":"8782222222"}}','2026-10-11 05:00:00')`,[neg]);
    await db.query(`INSERT INTO agente_turnos VALUES($1,ARRAY['wamid.qa'],'RECEPCION_QUEJA','productivo','2026-10-10T05:02:00Z')`,[neg]);
    const informe=await consultarEmbudo(db,{slug:'local',desde:'2026-10-10',hasta:'2026-10-12'});
    assert.equal(informe.total.mensajes,4);assert.equal(informe.total.conversaciones,2);
    assert.equal(informe.total.formulariosConfirmados,1);assert.equal(informe.total.formularioEntregado,1);
    assert.equal(informe.total.formularioYHumano,1);assert.equal(informe.total.tiendaEntregadaConConversacion,1);
    assert.equal(informe.total.motivosIntervencion.RECEPCION_QUEJA,1);
    assert.deepEqual(informe.porDia.map(x=>[x.dia,x.mensajes]),[['2026-10-10',3],['2026-10-11',1]]);
    assert.equal(informe.porDia[0].tiendaEntregadaSinConversacion,0);
    // La transacción terminó y siempre fue READ ONLY.
    const {rows:[r]}=await db.query('SHOW transaction_read_only');assert.equal(r.transaction_read_only,'off');
  });
} finally {
  await db.query(`DROP SCHEMA IF EXISTS ${esquema} CASCADE`).catch(()=>{});
  await db.end().catch(()=>{});await otro.end().catch(()=>{});
}
console.log(`ATENCION DB: ${n} pruebas correctas`);
