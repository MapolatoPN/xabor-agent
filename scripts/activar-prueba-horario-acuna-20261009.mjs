// El dueño autorizó probar su formulario fuera de horario. Solo una bandera
// temporal en Acuña; no cambia las reglas ni envía mensajes de prueba.
import assert from 'node:assert/strict';
import pg from 'pg';
import {pool} from '../src/services/database.js';
import {modoIA} from '../src/mesero-agente/recepcionista.js';
import {estadoParaPruebaDeHorario,CLAVE_PRUEBA_HORARIO,MAX_PRUEBA_HORARIO_MS} from '../src/mesero-agente/pruebaDeHorario.js';
const [modo]=process.argv.slice(2);
assert(['inspeccionar','activar'].includes(modo));assert(process.env.DATABASE_URL);
const id='bb27290a-3359-4348-ba60-03d89f97127f',telefono='528787899919';
const respaldo='whatsapp_prueba_horario_respaldo_20261009';
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:12000});
try {
  await db.connect();await db.query(modo==='activar'?'BEGIN':'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='15s'");
  const {rows:[n]}=await db.query(`SELECT slug,bot_whatsapp_activo FROM negocios WHERE id=$1 ${modo==='activar'?'FOR UPDATE':''}`,[id]);
  assert.equal(n?.slug,'mapolato-acuna');assert.equal(n.bot_whatsapp_activo,true);
  const {rows}=await db.query(`SELECT clave,valor FROM configuracion WHERE negocio_id=$1 ${modo==='activar'?'FOR UPDATE':''}`,[id]);
  const cfg=Object.fromEntries(rows.map(r=>[r.clave,r.valor]));
  assert.equal(cfg.bot_whatsapp_solo_prueba,'true');assert.equal(cfg.mesero_agente_porcentaje,'0');
  assert.equal(cfg.whatsapp_ia_modo_alcance,'prueba');
  assert(String(cfg.mesero_agente_telefonos).split(/[,;\n]+/).every(t=>[telefono,'5218787899919'].includes(t)));
  const ahora=new Date((await db.query('SELECT clock_timestamp() AS ahora')).rows[0].ahora);
  const prueba={negocioId:id,telefono,inicio:ahora.toISOString(),hasta:new Date(+ahora+MAX_PRUEBA_HORARIO_MS).toISOString()};
  const nuevo={...cfg,[CLAVE_PRUEBA_HORARIO]:JSON.stringify(prueba)};
  for(const t of [telefono,'5218787899919','528780000000']) {
    const r=estadoParaPruebaDeHorario({estadoRestaurante:{abierto:false},cfg:nuevo,ia:modoIA(nuevo,t),negocioId:id,telefono:t,canal:'whatsapp',ahora});
    assert.equal(r.abierto,t!=='528780000000');
  }
  if(modo==='activar') {
    assert(!cfg[respaldo],'Prueba ya registrada; inspeccionar antes de repetir');
    const {rows:actores}=await db.query("SELECT u.id FROM administradores_plataforma ap JOIN usuarios u ON u.id=ap.usuario_id WHERE ap.activo AND u.activo AND lower(u.nombre)='mario'");
    assert.equal(actores.length,1);
    await db.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)',[id,respaldo,JSON.stringify({antes:cfg[CLAVE_PRUEBA_HORARIO]??null,despues:prueba})]);
    await db.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
      ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`,[id,CLAVE_PRUEBA_HORARIO,JSON.stringify(prueba)]);
    await db.query(`INSERT INTO auditoria_plataforma(superadmin_id,accion,negocio_id,estado_anterior,estado_nuevo,contexto)
      VALUES($1,'habilitar_prueba_horario_dueno',$2,$3,$4,$5)`,[actores[0].id,id,
      JSON.stringify({[CLAVE_PRUEBA_HORARIO]:cfg[CLAVE_PRUEBA_HORARIO]??null}),JSON.stringify({[CLAVE_PRUEBA_HORARIO]:prueba}),
      JSON.stringify({autorizacion:'puedes cambiarlo para poder probarlo?',respaldo,envios:0})]);
    await db.query('COMMIT');
  }else await db.query('ROLLBACK');
  console.log(JSON.stringify({modo,negocio:n.slug,telefonoTerminacion:'9919',inicio:prueba.inicio,hasta:prueba.hasta,horas:2,reglasSinCambios:true,envios:0}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error('Operación detenida:',e.message);process.exitCode=1;}
finally{await db.end();await pool.end();}
