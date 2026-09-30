import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, crearUsuarioConPassword, guardarMensaje, getBotPausado, getTakeoverHumanoActivo } from '../src/services/database.js';
import { obtenerEstadoAtencionConversacion } from '../src/services/estadoAtencionConversacion.js';
import { crearTokenSesion } from '../src/services/session.js';
import { prepararNegocioBotones, exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';

exigirBaseBotonesLocal();
let srv, casos=0;
async function caso(nombre, fn) { await fn(); console.log(`OK HTTP atención ${++casos}: ${nombre}`); }
try {
  const a=await prepararNegocioBotones(), b=await prepararNegocioBotones();
  await guardarMensaje(a.telefono,'Local','entrante','Hola',a.negocioId,'cliente');
  await guardarMensaje(a.telefono,'Local','entrante','Hola',b.negocioId,'cliente');
  const usuario=await crearUsuarioConPassword({negocioId:a.negocioId,nombre:'Prueba estado',
    email:`estado-${randomUUID()}@example.invalid`,password:'Local-estado-123!',rol:'admin'});
  const cookie=`xabor_sesion=${encodeURIComponent(crearTokenSesion({usuarioId:usuario.id,negocioId:a.negocioId,rol:'admin'}))}`;
  srv=await arrancarServidor({PORT:process.env.TEST_PORT || '55971',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',
    META_GRAPH_BASE_URL:'http://127.0.0.1:1'}, {timeoutMs:30000});
  const url=`${srv.base}/api/conversacion/${a.telefono}`;
  const estado=async()=>{
    const r=await fetch(`${url}/estado-bot`,{headers:{Cookie:cookie}});
    assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');return r.json();
  };
  const post=async accion=>{
    const r=await fetch(`${url}/${accion}`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});
    assert.equal(r.status,200);return r.json();
  };
  await caso('estado sin bloqueos y nuevo JS servido',async()=>{
    const e=await estado();assert.equal(e.pausado,false);assert.equal(e.takeoverVigente,false);assert.equal(e.botWhatsappActivo,true);
    const js=await fetch(srv.base+'/estadoAtencionChat.js?v=20260930-1');assert.equal(js.status,200);assert.match(await js.text(),/crearConsulta/);
  });
  await caso('incidente: takeover real visible aunque pausa manual=false',async()=>{
    await pool.query("UPDATE clientes SET human_takeover_until=now()+interval '30 minutes' WHERE telefono=$1 AND negocio_id=$2",[a.telefono,a.negocioId]);
    const e=await estado();assert.equal(e.pausado,false);assert.equal(e.pausaManual,false);assert.equal(e.takeoverVigente,true);
    assert(new Date(e.takeoverHasta)>new Date(e.consultadoEn));
    assert.equal(await getTakeoverHumanoActivo(a.telefono,a.negocioId),true);
  });
  await caso('otro negocio con el mismo teléfono no hereda la pausa temporal',async()=>{
    const e=await obtenerEstadoAtencionConversacion(pool,b.negocioId,a.telefono);
    assert.equal(e.takeoverVigente,false);assert.equal(e.takeoverHasta,null);
    assert.equal(await getTakeoverHumanoActivo(a.telefono,b.negocioId),false);
  });
  await caso('tomar y devolver conservan takeover, sin falsa liberación',async()=>{
    assert.deepEqual(await post('pausar'),{ok:true,pausado:true});
    let e=await estado();assert(e.pausaManual);assert(e.takeoverVigente);
    assert.deepEqual(await post('reactivar'),{ok:true,pausado:false});
    e=await estado();assert.equal(e.pausaManual,false);assert.equal(e.takeoverVigente,true);
    assert.equal(await getBotPausado(a.telefono,a.negocioId),false);
    assert.equal(await getTakeoverHumanoActivo(a.telefono,a.negocioId),true);
  });
  await caso('vencimiento no borra pausa manual ni escribe la fila',async()=>{
    await post('pausar');
    await pool.query("UPDATE clientes SET human_takeover_until=now()-interval '1 second' WHERE telefono=$1",[a.telefono]);
    const antes=(await pool.query('SELECT * FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2',[a.negocioId,a.telefono])).rows;
    const e=await estado();assert.equal(e.takeoverVigente,false);assert.equal(e.pausaManual,true);
    const despues=(await pool.query('SELECT * FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2',[a.negocioId,a.telefono])).rows;
    assert.deepEqual(antes,despues);
  });
  await caso('revisión y acuse continúan visibles y protegidos',async()=>{
    await pool.query("UPDATE whatsapp_conversaciones SET requiere_revision=true,motivo='ESCALADA_MODELO' WHERE negocio_id=$1 AND telefono=$2",[a.negocioId,a.telefono]);
    const wamid=`wamid.local.estado.${randomUUID()}`;
    const entrada=(await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,'{}','completado') RETURNING id::text",
      [a.negocioId,a.telefono,wamid])).rows[0];
    await guardarMensaje(a.telefono,'Local','entrante','Mensaje para revisión',a.negocioId,'cliente',wamid);
    const e=await estado();assert.equal(e.requiereRevision,true);assert.equal(e.motivoRevision,'ESCALADA_MODELO');assert.equal(e.pausado,true);
    assert.equal(e.hastaEntrada,entrada.id);assert.equal(e.ultimaEntradaWamid,wamid);
    const historial=await fetch(url,{headers:{Cookie:cookie}});assert.equal(historial.status,200);
    assert((await historial.json()).some(m=>m.message_id_externo===e.ultimaEntradaWamid));
    const r=await fetch(url+'/reactivar',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});
    assert.equal(r.status,409);assert.equal(await getBotPausado(a.telefono,a.negocioId),true);
  });
  await caso('interruptor global se refleja sin tocar los demás bloqueos',async()=>{
    await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[a.negocioId]);
    const e=await estado();assert.equal(e.botWhatsappActivo,false);assert.equal(e.pausaManual,true);assert.equal(e.requiereRevision,true);
  });
  await caso('autenticación y pertenencia no se relajan',async()=>{
    assert.equal((await fetch(url+'/estado-bot')).status,401);
    await guardarMensaje(b.telefono,'Local','entrante','hola',b.negocioId,'cliente');
    const r=await fetch(`${srv.base}/api/conversacion/${b.telefono}/estado-bot`,{headers:{Cookie:cookie}});
    assert.equal(r.status,403);
  });
  await caso('estado legado NULL nunca se atribuye a Mapolato/negocio arbitrario',async()=>{
    await pool.query("UPDATE clientes SET negocio_id=NULL,human_takeover_until=now()+interval '1 hour' WHERE telefono=$1",[a.telefono]);
    const e=await estado();assert.equal(e.takeoverVigente,false);assert.equal(e.takeoverHasta,null);
    assert.equal(await getTakeoverHumanoActivo(a.telefono,a.negocioId),false);
    const nonna=(await pool.query("SELECT id FROM negocios WHERE slug='nonna-maye'")).rows[0];
    if(nonna) {
      const legado=await obtenerEstadoAtencionConversacion(pool,nonna.id,a.telefono);
      assert.equal(legado.takeoverVigente,await getTakeoverHumanoActivo(a.telefono,nonna.id));
      assert.equal(legado.takeoverVigente,true);
    }
  });
  console.log(`HTTP estado de atención: ${casos}/${casos}. Sin mensajes, pagos ni producción.`);
} finally {
  if(srv && srv.proc.exitCode===null) {
    const fin=new Promise(resolve=>srv.proc.once('exit',resolve));srv.detener();await fin;
  }
  await pool.end();
}
