import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ofertaAutoservicio,altaPlanHabilitada,MODULOS_PLAN_PRO} from '../src/services/planesAutoservicio.js';
import {validarCombinacion} from '../src/services/modulosDependencias.js';
import {construirPreapprovalBasico} from '../src/services/mercadoPagoSaasCliente.js';
test('ofertas cerradas, Básico con mesas, Pro sin voz ni IA y dependencias satisfechas',()=>{
  assert.equal(ofertaAutoservicio().montoMensual,150);assert.equal(ofertaAutoservicio().diasPrueba,7);
  assert.deepEqual(ofertaAutoservicio().modulos,['pos','menu','restaurante']);
  assert.equal(ofertaAutoservicio('pro').montoMensual,900);assert.equal(ofertaAutoservicio('pro').diasPrueba,0);
  assert.equal(ofertaAutoservicio('pro').instalacion,0);assert(!MODULOS_PLAN_PRO.includes('voz'));assert(!MODULOS_PLAN_PRO.includes('asistente_comercial_cotizaciones'));
  assert.equal(validarCombinacion(MODULOS_PLAN_PRO).ok,true);
  for(const plan of ['gratis','superadmin','PRO','',null,{},['pro']])assert.throws(()=>ofertaAutoservicio(plan),e=>e.code==='PLAN_INVALIDO');
});
test('Pro requiere su interruptor explícito; abrir Básico no lo abre',()=>{
  assert.equal(altaPlanHabilitada('pro',{XABOR_ALTA_PUBLICA_BASICO:'true'}),false);
  assert.equal(altaPlanHabilitada('pro',{XABOR_ALTA_PUBLICA_PRO:'true'}),true);
  for(const v of [true,'TRUE','1',undefined])assert.equal(altaPlanHabilitada('pro',{XABOR_ALTA_PUBLICA_PRO:v}),false);
});
test('checkout Pro usa su referencia, motivo y mensualidad sin cambiar Básico',()=>{
  const args={negocioId:'11111111-1111-4111-8111-111111111111',email:'qa@ejemplo.invalid',inicioCobro:new Date(Date.now()+120000),baseUrl:'https://xabor.mx'};
  const pro=construirPreapprovalBasico({...args,plan:'pro',montoMensual:900});
  assert.equal(pro.reason,'Xabor Pro — mensualidad');assert.equal(pro.external_reference,'xabor-pro:'+args.negocioId);
  assert.equal(pro.auto_recurring.transaction_amount,900);assert.equal(pro.auto_recurring.frequency_type,'months');assert.equal(pro.status,'pending');
  assert.equal(construirPreapprovalBasico(args).external_reference,'xabor-basico:'+args.negocioId);
  assert.throws(()=>construirPreapprovalBasico({...args,plan:'pro',cobroSinEspera:true}));
});
test('pantallas de contratación y registro conservan scripts sintácticamente válidos',()=>{
  for(const nombre of ['registro-basico','activar-basico','suscripcion-basico']){
    const html=readFileSync(new URL('../panel/'+nombre+'.html',import.meta.url),'utf8');
    for(const m of html.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Function(m[1]));
  }
});
