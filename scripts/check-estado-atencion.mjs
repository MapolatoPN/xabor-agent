import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { obtenerEstadoAtencionConversacion } from '../src/services/estadoAtencionConversacion.js';

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../panel/estadoAtencionChat.js', import.meta.url), 'utf8');
const sandbox = vm.createContext({}); vm.runInContext(js, sandbox);
const { crearConsulta, validarEstado } = sandbox.XaborEstadoAtencionChat;
const base = { pausado: false, pausaManual: false, botWhatsappActivo: true, requiereRevision: false,
  motivoRevision: null, hastaEntrada: '1', takeoverVigente: false, takeoverHasta: null,
  consultadoEn: '2026-09-30T14:00:00Z' };
const temporal = { takeoverVigente: true, takeoverHasta: '2026-09-30T14:30:00Z' };
let casos = 0;
async function caso(nombre, fn) { await fn(); console.log(`OK atención ${++casos}: ${nombre}`); }
function diferido() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
function vista(estado, cambiando = false) {
  const elementos = {};
  for (const id of ['chat-estado-card','btn-toggle-bot','chat-atencion-estado','chat-estado-sub','chat-estado-ico']) {
    elementos[id] = {dataset:{},style:{},classList:{add(){},remove(){}}};
  }
  const ctx = vm.createContext({document:{getElementById:id=>elementos[id]},chatAbierto:'prueba',
    estadoAtencionChat:estado,cambiandoAtencionChat:cambiando,mensajesVistosChat:new Set(),explicarMotivoRevision:()=>'Revisión requerida'});
  const inicio = html.indexOf('function actualizarBotonBot()');
  assert(inicio > 0);
  vm.runInContext(html.slice(inicio,html.indexOf('// Relee el estado',inicio)),ctx);
  ctx.actualizarBotonBot();
  return { ctx, elementos, boton:elementos['btn-toggle-bot'],titulo:elementos['chat-atencion-estado'].textContent,
    detalle:elementos['chat-estado-sub'].textContent };
}
const ver = e => vista({situacion:'verificado',...base,...e});
function accion(estado, enviar, siguiente) {
  const v=ver(estado), avisos=[], consultas=[];
  Object.assign(v.ctx,{AbortController,setTimeout,clearTimeout,encodeURIComponent,
    apiFetch:enviar,confirm:()=>true,mostrarErrorChat:e=>avisos.push(e)});
  const inicio=html.indexOf('async function toggleBotPausado()');
  vm.runInContext(html.slice(inicio,html.indexOf('\nfunction escaparHTML',inicio)),v.ctx);
  v.ctx.refrescarAcuseRevision=async telefono=>{
    consultas.push(telefono);v.ctx.estadoAtencionChat=siguiente;
  };
  return {...v,avisos,consultas};
}
await caso('reproduce incidente: takeover sin pausa manual no dice Tomar ni habilitada', () => {
  const v=ver(temporal); assert.match(v.titulo,/Personal atendiendo/);
  assert.equal(v.boton.textContent,'Mantener atención manual'); assert.match(v.detalle,/hasta .*dispositivo/);
});
await caso('pausa manual y combinación con takeover son distintas', () => {
  const manual={pausado:true,pausaManual:true};
  assert.equal(ver(manual).boton.textContent,'Devolver al bot');
  const v=ver({...manual,...temporal}); assert.equal(v.boton.textContent,'Quitar pausa manual');
  assert.match(v.detalle,/no elimina esa espera/);
});
await caso('global apagado no ofrece tomar; revisión conserva acuse sin prometer reactivación', () => {
  assert.equal(ver({botWhatsappActivo:false}).boton.style.display,'none');
  const v=ver({botWhatsappActivo:false,pausado:true,requiereRevision:true,...temporal});
  assert.equal(v.boton.textContent,'Revisé y atendí los pendientes'); assert.match(v.detalle,/Revisión requerida/);
});
await caso('sin bloqueos se ofrece tomar; no se promete respuesta o formulario', () => {
  assert.equal(ver({}).boton.textContent,'Tomar conversación');
  assert.equal(ver({}).titulo,'Atención automática habilitada');
});
await caso('error/carga impiden acciones y no dicen activa', () => {
  for(const situacion of ['no_disponible','cargando']) {
    const v=vista({situacion}); assert.equal(v.boton.disabled,true);
    assert.doesNotMatch(v.titulo,/habilitada|Bot atendiendo/);
  }
  assert.equal(vista({situacion:'verificado',...base},true).boton.disabled,true);
});
await caso('datos incompletos o incoherentes nunca se asumen activos', () => {
  for(const e of [{pausado:false},{...base,takeoverVigente:true},{...base,pausado:true},null]) {
    assert.throws(()=>validarEstado(e));
  }
});
await caso('lectura vieja de A no pinta B (ni una reapertura de A)', async () => {
  const cola=[],pintados=[];
  const c=crearConsulta({consultar:t=>{const d=diferido();cola.push({t,...d});return d.promise;},pintar:e=>pintados.push(e)});
  const a=c.abrir('A'); await Promise.resolve();
  const b=c.abrir('B'); await Promise.resolve();
  cola[1].resolve({...base,...temporal}); await b;
  cola[0].resolve(base); await a;
  assert.equal(pintados.at(-1).takeoverVigente,true);
  const viejo=c.refrescar(); await Promise.resolve();
  c.cerrar(); const nuevo=c.abrir('B'); await Promise.resolve();
  cola[3].resolve({...base,pausado:true,pausaManual:true}); await nuevo;
  cola[2].reject(Error('red')); await viejo;
  assert.equal(pintados.at(-1).pausaManual,true);
});
await caso('fallo tras estado activo lo invalida; recuperación vuelve a pintar', async () => {
  let falla=false; const pintados=[];
  const c=crearConsulta({consultar:async()=>{if(falla)throw Error('red');return base;},pintar:e=>pintados.push(e)});
  await c.abrir('A'); falla=true; await c.refrescar();
  assert.equal(pintados.at(-1).situacion,'no_disponible');
  falla=false; await c.refrescar(); assert.equal(pintados.at(-1).situacion,'verificado');
});
await caso('poll concurrente comparte lectura; invalidación descarta resultado anterior', async () => {
  const cola=[],pintados=[];
  const c=crearConsulta({consultar:()=>{const d=diferido();cola.push(d);return d.promise;},pintar:e=>pintados.push(e)});
  const a=c.abrir('A'); assert.equal(c.refrescar(),a); await Promise.resolve();
  const b=c.refrescar({invalidar:true}); await Promise.resolve();
  cola[1].resolve({...base,...temporal}); await b; cola[0].resolve(base); await a;
  assert.equal(pintados.at(-1).takeoverVigente,true);
});
await caso('vencimiento se decide por respuesta nueva del servidor, no reloj cliente', async () => {
  let activo=true;const pintados=[];
  const c=crearConsulta({consultar:async()=>({...base,...temporal,takeoverVigente:activo}),pintar:e=>pintados.push(e)});
  await c.abrir('A'); assert.equal(pintados.at(-1).takeoverVigente,true);
  activo=false; await c.refrescar(); assert.equal(pintados.at(-1).takeoverVigente,false);
});
await caso('servicio es SELECT parametrizado y propaga errores; no libera pausas', async () => {
  let llamadas=0;
  const db={query:async(sql,params)=>{llamadas++;assert.match(sql,/^\s*SELECT/);assert.doesNotMatch(sql,/\b(UPDATE|INSERT|DELETE)\b/);
    assert.deepEqual(params,['negocio','telefono']);return {rows:[{bot_whatsapp_activo:true,pausa_manual:false,
      requiere_revision:false,takeover_vigente:true,takeover_hasta:temporal.takeoverHasta,consultado_en:base.consultadoEn}]};}};
  const e=await obtenerEstadoAtencionConversacion(db,'negocio','telefono');
  assert.equal(llamadas,1);assert.equal(e.pausado,false);assert.equal(e.takeoverVigente,true);
  await assert.rejects(obtenerEstadoAtencionConversacion({query:async()=>{throw Error('DB');}},'negocio','telefono'));
  await assert.rejects(obtenerEstadoAtencionConversacion(db,'','telefono'));
});
await caso('integración refresca estado completo: polling, WS y retorno de acción; no inversión optimista', () => {
  assert.match(html,/void refrescarAcuseRevision\(telefono\)/);
  assert.match(html,/refrescarAcuseRevision\(chatAbierto, true\)/);
  assert.match(html,/await refrescarAcuseRevision\(telefono, true\)/);
  assert.doesNotMatch(html,/catch\(\(\) => \(\{ pausado:false/);
  assert.doesNotMatch(html,/actualizarBotonBot\(!pausado\)/);
});
await caso('botón real devuelve pausa manual y muestra takeover que sigue vigente', async () => {
  const enviados=[];
  const v=accion({pausado:true,pausaManual:true,...temporal},async(url,opts)=>{
    enviados.push({url,opts});return {ok:true};
  },{situacion:'verificado',...base,...temporal});
  await v.ctx.toggleBotPausado();
  assert.equal(enviados.length,1);assert.match(enviados[0].url,/\/prueba\/reactivar$/);
  assert.equal(v.boton.textContent,'Mantener atención manual');assert.equal(v.boton.disabled,false);
  assert.deepEqual(v.consultas,['prueba']);
});
await caso('botón real: fallo de envío + fallo de lectura bloquea sin reintentar POST', async () => {
  let envios=0;
  const v=accion({},async()=>{envios++;throw Error('red');},{situacion:'no_disponible'});
  await v.ctx.toggleBotPausado(); await v.ctx.toggleBotPausado();
  assert.equal(envios,1);assert.equal(v.boton.disabled,true);assert.match(v.avisos[0],/No pudimos comprobar/);
});
await caso('botón real: cambiar de chat durante un POST no pinta ni avisa sobre el chat nuevo', async () => {
  const d=diferido(),v=accion({},()=>d.promise,{situacion:'no_disponible'});
  const tarea=v.ctx.toggleBotPausado();v.ctx.chatAbierto='B';
  v.ctx.estadoAtencionChat={situacion:'verificado',...base,...temporal};
  d.resolve({ok:false,json:async()=>({error:'error del chat anterior'})});await tarea;
  assert.equal(v.avisos.length,0);assert.equal(v.consultas.length,0);
  assert.equal(v.boton.textContent,'Mantener atención manual');assert.equal(v.boton.disabled,false);
});
await caso('ruta GET real responde 503 sin inventar estado ni filtrar el error interno', async () => {
  const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const inicio=server.indexOf("app.get('/api/conversacion/:telefono/estado-bot'");
  let handler; const ctx=vm.createContext({app:{get:(...args)=>{handler=args.at(-1);}},
    requireAdminSeguro(){},requireModulo:()=>()=>{},validarConversacionPropia(){},pool:{},
    obtenerEstadoAtencionConversacion:async()=>{throw Error('dato interno');},console:{error(){}}});
  vm.runInContext(server.slice(inicio,server.indexOf('\n});',inicio)+4),ctx);
  let code=200,body,cache;const res={set:(k,v)=>{cache=v;},status:c=>{code=c;return res;},json:v=>{body=v;}};
  await handler({negocioId:'negocio',params:{telefono:'telefono'}},res);
  assert.equal(code,503);assert.equal(cache,'no-store');assert.equal(body.pausado,undefined);
  assert.doesNotMatch(body.error,/dato interno/);
});
await caso('el polling no acredita mensajes que aún no se mostraron; revisión sigue protegida', async () => {
  let envios=0;
  const e={pausado:true,requiereRevision:true,ultimaEntradaWamid:'wamid.pendiente',hastaEntrada:'99'};
  const v=accion(e,async()=>{envios++;return {ok:true};},{situacion:'verificado',...base});
  assert.equal(v.boton.disabled,true);await v.ctx.toggleBotPausado();assert.equal(envios,0);
  v.ctx.mensajesVistosChat.add('wamid.pendiente');v.ctx.actualizarBotonBot();assert.equal(v.boton.disabled,false);
  await v.ctx.toggleBotPausado();assert.equal(envios,1);
});
console.log(`Estado de atención: ${casos}/${casos}`);
