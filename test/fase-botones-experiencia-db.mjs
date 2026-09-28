import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioMixtos, prepararNegocioBotones } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';

process.env.MESERO_AGENTE_MODE='true';process.env.WHATSAPP_INTERACTIVOS='true';
const noModelo=async()=>{throw Error('NO_MODELO');};
let n=0;
const caso=async(nombre,fn)=>{await fn();console.log(`OK experiencia DB ${++n}: ${nombre}`);};
async function fixture({resumen=false,entregar=true}={}) {
  const f=await (resumen?prepararNegocioBotones():prepararNegocioMixtos());
  const leer=()=>leerEstadoVersionado(f.negocioId,f.telefono);
  const entrada=async m=>pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",[f.negocioId,f.telefono,m.id,JSON.stringify({message:m})]);
  const identidad=()=>({id:`wamid.ux.${randomUUID()}`,from:f.telefono,timestamp:String(Math.floor(Date.now()/1000))});
  const texto=body=>({...identidad(),type:'text',text:{body}});
  const filas=q=>q.interactivo.type==='list'?q.interactivo.action.sections[0].rows:q.interactivo.action.buttons.map(b=>b.reply);
  const toque=(q,title)=>{
    const row=filas(q).find(r=>r.title===title);assert(row,`No existe ${title}`);
    const type=q.interactivo.type==='list'?'list_reply':'button_reply';
    return {...identidad(),type:'interactive',context:{id:q.wamid},interactive:{type,[type]:{id:row.id,title:'NO ES AUTORIDAD'}}};
  };
  const procesar=async(mensajes,{enviar=true}={})=>{
    for(const m of mensajes)await entrada(m);
    const toques=mensajes.filter(m=>m.type==='interactive'),textos=mensajes.filter(m=>m.type==='text');
    const r=await atenderConAgente({...f,mensaje:textos.map(m=>m.text.body).join('\n'),wamids:mensajes.map(m=>m.id),
      ...(toques.length?{interaccion:{mensajes:toques,mixto:!!textos.length}}:{}),llamarModelo:noModelo});
    assert.equal(r.ok,true,JSON.stringify(r));
    if(!r.outbox)return {r};
    const q=(await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1',[r.outbox.clave])).rows[0];
    const wamid=`wamid.ux.out.${randomUUID()}`;
    if(enviar)assert.equal((await entregarRespuesta({outboxClave:q.evento_clave,enviar:async()=>({messages:[{id:wamid}]}),alHumano:async()=>true})).estado,'entregado');
    return {r,...q.carga,clave:q.evento_clave,wamid};
  };
  const inicial=await procesar([texto('Hola')],{enviar:entregar});
  return {...f,leer,texto,toque,procesar,inicial};
}
try {
  await caso('misma lista: unión atómica, deduplicación por token y cierre bloquea los anteriores',async()=>{
    const f=await fixture(),o=f.inicial;
    let q=await f.procesar([f.toque(o,'Roja'),f.toque(o,'Verde')]);
    assert.deepEqual((await f.leer()).carrito.items[0].modificadores[0].opciones,['Roja','Verde']);
    const constancia=(await pool.query('SELECT resultado FROM agente_preguntas_interactivas WHERE outbox_clave=$1',[o.clave])).rows[0];
    assert.equal(constancia.resultado.tokens.length,2);
    assert.equal((await f.procesar([f.toque(o,'Roja')])).r.sinRespuesta,true);
    q=await f.procesar([f.toque(q,'Continuar')]);assert.equal((await f.leer()).pendiente.grupo,'Proteína');
    q=await f.procesar([f.toque(o,'Suiza')]);assert.match(q.texto,/no está vigente/);
    assert.equal((await f.leer()).carrito.items[0].modificadores[0].opciones.length,2);
    assert.equal((await f.procesar([f.toque(o,'Suiza')])).r.sinRespuesta,true);
  });
  await caso('otro precio invalida también una opción no consumida de la lista original',async()=>{
    const f=await fixture(),o=f.inicial;await f.procesar([f.toque(o,'Roja')]);
    await pool.query('UPDATE menu_productos SET precio=precio+10 WHERE id=$1',[f.mixtosId]);
    const q=await f.procesar([f.toque(o,'Verde')]);assert.match(q.texto,/no está vigente/);
    assert.deepEqual((await f.leer()).carrito.items[0].modificadores[0].opciones,['Roja']);
  });
  await caso('cambiar por botón y elegir por texto reemplaza; continuar escrito avanza',async()=>{
    const f=await fixture(),o=f.inicial;
    let q=await f.procesar([f.toque(o,'Roja'),f.toque(o,'Verde')]);
    q=await f.procesar([f.toque(q,'Cambiar selección')]);
    assert.deepEqual((await f.leer()).carrito.items[0].modificadores[0].opciones,['Roja','Verde']);
    await f.procesar([f.texto('Suiza')]);
    assert.deepEqual((await f.leer()).carrito.items[0].modificadores[0].opciones,['Suiza']);
    assert.equal((await f.leer()).eleccionInteractiva.editando,false);
    await f.procesar([f.texto('Continuar')]);
    assert.equal((await f.leer()).pendiente.grupo,'Proteína');
  });
  await caso('mixtos con dos salsas, dos proteínas de siete y dos guarniciones; extra visible y total exacto',async()=>{
    const f=await fixture();
    const {rows:[g]}=await pool.query("UPDATE menu_modificadores_grupos SET maximo=2 WHERE negocio_id=$1 AND producto_id=$2 AND nombre='Proteína' RETURNING id",[f.negocioId,f.mixtosId]);
    await pool.query("UPDATE menu_modificadores_opciones SET nombre=CASE nombre WHEN 'Pollo' THEN 'Pechuga de pollo' ELSE 'Huevos Estrellados' END,precio_extra=0 WHERE grupo_id=$1",[g.id]);
    for(const [i,nombre] of ['Huevos Revueltos','Chicharron Prensado','Bistec en Salsa','Queso Panela en Salsa','Chicharron Cuerito en Salsa'].entries())
      await pool.query('INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden) VALUES($1,$2,$3,$4,true,$5)',[f.negocioId,g.id,nombre,i<2?0:30,i+2]);
    let q=await f.procesar([f.toque(f.inicial,'Roja'),f.toque(f.inicial,'Verde')]);
    q=await f.procesar([f.toque(q,'Continuar')]);
    const proteinas=q,filas=q.interactivo.action.sections[0].rows;
    assert.equal(filas.length,7);assert(q.texto.length<200);
    assert.equal(filas.find(r=>r.title==='Bistec en Salsa').description,'+$30');
    const larga=filas.find(r=>r.description?.includes('Chicharron Cuerito'));
    assert(larga.title.length<=24);assert.match(larga.description,/^\+\$30/);
    await f.procesar([f.toque(proteinas,'Pechuga de pollo')]);
    q=await f.procesar([f.toque(proteinas,'Bistec en Salsa')]);
    assert.deepEqual((await f.leer()).carrito.items[0].modificadores.find(g=>g.grupo==='Proteína').opciones,['Pechuga de pollo','Bistec en Salsa']);
    q=await f.procesar([f.toque(q,'Continuar')]);
    q=await f.procesar([f.toque(q,'Frijoles'),f.toque(q,'Papas a la mexicana')]);
    q=await f.procesar([f.toque(q,'Continuar')]);
    q=await f.procesar([f.toque(q,q.interactivo.action.buttons[0].reply.title)]);
    q=await f.procesar([f.toque(q,'efectivo')]);
    assert.match(q.texto,/Total: \$150/);assert.equal((await f.leer()).folio,null);
  });
  await caso('texto y toque juntos: solo se atiende el texto; lista anterior no reaparece',async()=>{
    const f=await fixture(),o=f.inicial;
    const q=await f.procesar([f.toque(o,'Roja'),f.texto('cambia a verde')]);
    assert.deepEqual((await f.leer()).carrito.items[0].modificadores[0].opciones,['Verde']);
    assert.equal((await f.procesar([f.toque(o,'Roja')])).r.sinRespuesta,true);
    assert.match(q.texto,/Verde/);
  });
  await caso('bot apagado y pausa humana dominan incluso una lista abierta',async()=>{
    for(const pausa of [false,true]){
      const f=await fixture();await f.procesar([f.toque(f.inicial,'Roja')]);
      if(pausa)await pool.query('INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)',[f.negocioId,f.telefono]);
      else await pool.query('UPDATE negocios SET bot_whatsapp_activo=false WHERE id=$1',[f.negocioId]);
      assert.equal((await f.procesar([f.toque(f.inicial,'Verde')])).r.sinRespuesta,true);
      assert.deepEqual((await f.leer()).carrito.items[0].modificadores[0].opciones,['Roja']);
    }
  });
  await caso('Agregar otro por botón invalida Confirmar sin alterar el pedido',async()=>{
    const f=await fixture({resumen:true}),antes=(await f.leer()).carrito;
    const q=await f.procesar([f.toque(f.inicial,'Agregar otro')]);
    assert.match(q.texto,/Qué te gustaría agregar/);assert.equal((await f.leer()).pendiente.tipo,'agregar_otro');
    const aviso=await f.procesar([f.toque(f.inicial,'Confirmar')]);assert.match(aviso.texto,/no está vigente/);
    assert.equal((await f.leer()).pendiente.tipo,'agregar_otro');assert.deepEqual((await f.leer()).carrito,antes);
    assert.equal((await f.leer()).folio,null);
  });
  await caso('Confirmar y Cambiar juntos: no escoger arbitrariamente ni crear pedido',async()=>{
    const f=await fixture({resumen:true}),antes=(await f.leer()).carrito;
    const q=await f.procesar([f.toque(f.inicial,'Confirmar'),f.toque(f.inicial,'Cambiar algo')]);
    assert.match(q.texto,/varias decisiones distintas/);
    assert.equal((await f.leer()).folio,null);assert.deepEqual((await f.leer()).carrito,antes);
    assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1',[f.negocioId])).rows[0].n,0);
  });
  await caso('bandera apagada al despachar: texto legible con opciones y cargos, no pregunta sin lista',async()=>{
    const f=await fixture({entregar:false});await actualizarConfiguracion({whatsapp_interactivos_v1:'false'},f.negocioId);
    let enviado;
    await entregarRespuesta({outboxClave:f.inicial.clave,enviar:async c=>{enviado=c;return {messages:[{id:'wamid.fallback.local'}]};},alHumano:async()=>true});
    assert.equal(enviado.interactivo,null);assert.match(enviado.texto,/Chipotle \(\+\$5\)/);assert.match(enviado.texto,/Roja/);
    const {rows:[o]}=await pool.query('SELECT carga FROM agente_outbox WHERE evento_clave=$1',[f.inicial.clave]);
    assert.equal(o.carga.texto_enviado,enviado.texto);
  });
  await caso('runner 104/105 repetido conserva asociaciones nuevas sin degradar el esquema',async()=>{
    const huella=async()=> (await pool.query("SELECT md5(string_agg(row_to_json(b)::text,'|' ORDER BY token)) AS h FROM agente_botones b")).rows[0].h;
    const antes=await huella();
    assert((await pool.query("SELECT count(*)::int n FROM agente_botones WHERE accion='editar_grupo'")).rows[0].n>0);
    for(let i=0;i<2;i++)for(const script of ['predeploy-104-agente-elecciones','predeploy-105-agente-edicion-interactiva'])
      execFileSync(process.execPath,[`scripts/${script}.mjs`],{stdio:'pipe',timeout:30000});
    assert.equal(await huella(),antes);
    const regla=(await pool.query("SELECT pg_get_constraintdef(oid) regla FROM pg_constraint WHERE conrelid='agente_botones'::regclass AND conname='agente_botones_accion_check'")).rows[0].regla;
    for(const accion of ['agregar_otro','editar_grupo','conservar_grupo','reemplazar_grupo']) assert(regla.includes(`'${accion}'`));
  });
  console.log(`Experiencia DB: ${n}/${n}; sin Meta, pedidos, pagos ni impresión externos.`);
} finally {await pool.end();}
