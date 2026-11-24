import test from 'node:test';
import assert from 'node:assert/strict';
import {cuentaPilotoBasico,inicioCobroBasico} from '../src/services/pilotoCobroBasico.js';
import {construirPreapprovalBasico} from '../src/services/mercadoPagoSaasCliente.js';
const negocioId='00000000-0000-4000-8000-000000000123',usuarioId='00000000-0000-4000-8000-000000000456';
const env={XABOR_PILOTO_COBRO_NEGOCIO_ID:negocioId,XABOR_PILOTO_COBRO_USUARIO_ID:usuarioId};
const ahora=Date.parse('2026-11-24T13:00:00Z'),pruebaHasta='2026-12-01T13:00:00Z';
test('piloto apagado sin pareja explícita y limitado al usuario, negocio y precio autorizados',()=>{
 const cuenta={negocioId,usuarioId,montoMensual:150};
 assert.equal(cuentaPilotoBasico(cuenta,{}),false);assert.equal(cuentaPilotoBasico(cuenta,env),true);
 for(const cambio of [{negocioId:usuarioId},{usuarioId:negocioId},{montoMensual:151},{negocioId:'*'},{usuarioId:undefined}])assert.equal(cuentaPilotoBasico({...cuenta,...cambio},env),false);
 assert.equal(cuentaPilotoBasico(cuenta,{...env,XABOR_PILOTO_COBRO_USUARIO_ID:'*'}),false);
});
test('la contratación normal conserva los siete días aunque exista un piloto',()=>{
 assert.equal(inicioCobroBasico({pruebaHasta,ahora}).toISOString(),pruebaHasta.replace('Z','.000Z'));
});
test('el piloto solicita el inicio próximo sin esperar al fin de prueba',()=>{
 assert.equal(inicioCobroBasico({pruebaHasta,ahora,sinEspera:true}).getTime(),ahora+120000);
});
test('el inicio nunca vuelve a cobrar dentro de un periodo ya pagado',()=>{
 const pagadoHasta='2027-01-01T13:00:00Z';
 for(const sinEspera of [true,false])assert.equal(inicioCobroBasico({pruebaHasta,pagadoHasta,ahora,sinEspera}).getTime(),Date.parse(pagadoHasta));
});
test('fechas inválidas no producen una fecha silenciosa de cobro',()=>{
 assert.throws(()=>inicioCobroBasico({pruebaHasta:'incorrecta',ahora}));
 assert.throws(()=>inicioCobroBasico({pruebaHasta,pagadoHasta:'incorrecta',ahora}));
});
test('MP recibe mensualidad explícita del piloto y no una prueba gratuita',()=>{
 const r=construirPreapprovalBasico({negocioId,email:'piloto@ejemplo.invalid',inicioCobro:inicioCobroBasico({pruebaHasta,ahora,sinEspera:true}),baseUrl:'https://xabor.mx',montoMensual:150,cobroSinEspera:true});
 assert.match(r.reason,/piloto sin espera/);assert.equal(r.status,'pending');
 assert.equal(r.auto_recurring.transaction_amount,150);assert.equal(r.auto_recurring.currency_id,'MXN');
 assert.equal(r.auto_recurring.frequency,1);assert.equal(r.auto_recurring.frequency_type,'months');assert.equal(r.auto_recurring.free_trial,undefined);
});
