import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { seguimientoFormulario,vistaFormularioEnviado } from '../src/services/seguimientoFormulario.js';
import { eventoActividadFormulario,registrarActividadFormulario } from '../src/mesero-agente/actividadFormulario.js';
const ahora=Date.parse('2026-09-30T16:00:00Z'),at=min=>new Date(ahora-min*60_000).toISOString();
const base={estado:'disponible',created_at:at(20)};
let n=0;async function caso(t,f){await f();console.log(`OK seguimiento ${++n}: ${t}`);}
await caso('sin evidencia no equivale a no abrir o perder interés',()=>{
  const s=seguimientoFormulario(base,{ahora});assert.equal(s.codigo,'sin_evidencia');assert.equal(s.sugerirAyuda,false);
  assert.equal(s.ultimaActividad,null);assert.equal(s.aperturaObservada,null);
});
await caso('apertura, edición e inactividad observadas sin confirmar',()=>{
  const s=seguimientoFormulario({...base,eventos:[{tipo:'paso',paso:'CARRITO',observado_at:at(12)},
    {tipo:'apertura',paso:'CARRITO',observado_at:at(19)}]},{ahora});
  assert.equal(s.codigo,'iniciado');assert.equal(s.aperturaObservada,at(19));assert.equal(s.ultimaActividad,at(12));
  assert.equal(s.minutosSinActividad,12);assert(s.sugerirAyuda);assert.match(s.titulo,/sin actividad/);
  assert.doesNotMatch(s.titulo,/abandon|perdió|confirmad|en línea/i);
});
await caso('respuesta final y aplicación prevalecen sobre inactividad',()=>{
  for(const [extra,codigo] of [[{respuesta_recibida:'w'},'recibido'],
    [{estado:'terminada',resultado:{formulario_aplicado:true}},'aplicado'],
    [{estado:'terminada',resultado:{formulario_aplicado:false}},'no_aplicado'],[{estado:'incierta',respuesta_recibida:'w'},'revision']]) {
    const s=seguimientoFormulario({...base,created_at:at(90),...extra},{ahora});
    assert.equal(s.codigo,codigo);assert.equal(s.sugerirAyuda,false);
  }
});
await caso('caducidad y datos históricos no inventan una apertura',()=>{
  const s=seguimientoFormulario({...base,created_at:at(31),etapa:'EDITAR',revision:'2',actualizado_at:at(27)},{ahora});
  assert.equal(s.codigo,'vencido');assert.equal(s.aperturaObservada,null);assert.equal(s.evidencia,'borrador');
  assert.equal(seguimientoFormulario({...base,created_at:at(30)},{ahora}).codigo,'vencido');
  assert.equal(seguimientoFormulario({...base,estado:'terminada'},{ahora}).codigo,'cerrado');
  const copiado=seguimientoFormulario({...base,revision:'2',actualizado_at:at(1),etapa:'CARRITO'},{ahora});
  assert.equal(copiado.codigo,'borrador');assert.equal(copiado.ultimaActividad,null);assert(!copiado.sugerirAyuda);
  assert.equal(copiado.paso,null);assert.equal(copiado.borradorGuardado,at(1));
  const antiguo=seguimientoFormulario({...base,vigente_dialogo:false,eventos:[{tipo:'apertura',observado_at:at(15)}]},{ahora});
  assert.equal(antiguo.codigo,'cerrado');assert(!antiguo.sugerirAyuda);
});
await caso('solo campos cerrados, no token ni contenido del cliente',()=>{
  const e=eventoActividadFormulario({action:'data_exchange',data:{observaciones:'SECRETO',flow_token:'TOKEN'}},
    {borrador:{revision:3,etapa:'EDITAR',nota:'SECRETO'}},'a'.repeat(64));
  assert.deepEqual(e,{clave:'a'.repeat(64),tipo:'paso',paso:'EDITAR',revision:3});
  assert.equal(eventoActividadFormulario({action:'ping'},{borrador:{revision:0}},'a'.repeat(64)),null);
  assert.equal(eventoActividadFormulario({action:'INIT'},{borrador:{revision:NaN}},'a'.repeat(64)),null);
  const v=vistaFormularioEnviado({tipo:'flow_configurar',flow_token:'TOKEN',version:'carrito_v1',lineas:[
    {linea_id:'ID-SECRETO',nota:'SECRETO',ficha:{id:'SECRETO',nombre:'Chilaquiles',precio:195,
      grupos:[{nombre:'Salsa',minimo:1,maximo:2,opciones:[{nombre:'Verde',precio:0}]}]}}]});
  assert(!JSON.stringify(v).includes('SECRETO'));assert(!JSON.stringify(v).includes('TOKEN'));
  assert.equal(v.productos[0].grupos[0].opciones[0].nombre,'Verde');
});
await caso('falla de telemetría no deja abortada la transacción de pedido',async()=>{
  const consultas=[];const tx={query:async(sql)=>{consultas.push(sql);if(sql.startsWith('INSERT'))throw Error('DB');return {rowCount:0};}};
  assert.equal(await registrarActividadFormulario(tx,'pregunta',{clave:'a'.repeat(64),tipo:'paso',paso:'CARRITO',revision:1}),false);
  assert(consultas.includes('ROLLBACK TO SAVEPOINT actividad_formulario'));assert.equal(consultas.at(-1),'RELEASE SAVEPOINT actividad_formulario');
});
await caso('vista segura, sin ejecución ni reenvío y formato compacto',()=>{
  const sandbox={Intl};vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../panel/formulariosChat.js',import.meta.url),'utf8'),sandbox);
  const f=sandbox.FormulariosChat;
  const html=f.seguimiento({titulo:'<img onerror=alert(1)>',sugerirAyuda:true,paso:'Carrito',aclaracion:'No indica abandono'})
    +f.formulario({alcance:'Snapshot',productos:[{nombre:'<script>mal</script>',precio:195,grupos:[]}],modalidades:[],pagos:[]});
  assert(!html.includes('<script>'));assert(!html.includes('<img'));assert(!/onclick=|<button|<input|<form\b/.test(html));
  assert.match(html,/Ver formulario enviado/);assert.match(html,/solo lectura/);
});
console.log(`OK ${n} grupos de seguimiento de formularios.`);
