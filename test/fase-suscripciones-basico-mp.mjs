import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PRECIO_SAAS_MXN, construirPreapprovalBasico, enlaceMPValido,
  validarFirmaWebhookMp, validarCobroSaas, consultarMpSaas,
  mpSaasHabilitado,
  buscarFacturaMpSaasPorPago, buscarFacturasMpSaasPorContrato,
} from '../src/services/mercadoPagoSaasCliente.js';

const negocioId='00000000-0000-4000-8000-000000000123';
const referencia='xabor-basico:'+negocioId;
const factura=()=>({
  id: '100', preapproval_id: 'MP-CORRECT', currency_id:'MXN',
  transaction_amount:'150.00', payment:{id:'200',status:'approved'},
});
const pago=()=>({
  id:200, status:'approved', currency_id:'MXN', transaction_amount:150,
  date_approved:'2026-11-22T16:00:00.000Z',
});

test('checkout pendiente: $150 MXN recurrente mensual con fecha posterior',()=>{
  const d=construirPreapprovalBasico({
    negocioId,email:'cliente@ejemplo.mx',
    inicioCobro:'2026-11-30T12:00:00Z',baseUrl:'https://xabor.mx',
  });
  assert.equal(d.status,'pending');
  assert.equal(d.auto_recurring.transaction_amount,PRECIO_SAAS_MXN);
  assert.equal(d.auto_recurring.currency_id,'MXN');
  assert.equal(d.auto_recurring.frequency,1);
  assert.equal(d.auto_recurring.frequency_type,'months');
  assert.equal(d.auto_recurring.start_date,'2026-11-30T12:00:00.000Z');
  assert.equal(d.external_reference,referencia);
  assert.equal(d.back_url,'https://xabor.mx/suscripcion-basico');
  assert.equal(d.card_token_id,undefined);
  assert.equal(d.negocio_id,undefined);
});
test('nunca redirigir a checkout de un dominio falso',()=>{
  assert.equal(enlaceMPValido('https://www.mercadopago.com.mx/subscriptions/checkout?a=1'),true);
  assert.equal(enlaceMPValido('https://www.mercadopago.com.ar/subscriptions/checkout?a=1'),true);
  for(const url of [
    'https://mercadopago.com.mx.evil.example/', 'http://www.mercadopago.com.mx/',
    'javascript:alert(1)', 'https://www.mercadopago.com.mx@evil.test/',
    'https://mercadopago.com.mx.evil.test/',
  ])assert.equal(enlaceMPValido(url),false,url);
});
test('firma HMAC del webhook: válida, alterada, vencida y sin secreto',()=>{
  const secret='WEBHOOK-SECRET-FAKE';
  const ahora=Date.parse('2026-11-22T16:00:00Z'),ts=String(Math.floor(ahora/1000));
  const requestId='req-ejemplo',dataId='100';
  const manifiesto=`id:${dataId};request-id:${requestId};ts:${ts};`;
  const firma=createHmac('sha256',secret).update(manifiesto).digest('hex');
  const datos={signature:`ts=${ts},v1=${firma}`,requestId,dataId,secret,ahora};
  assert.equal(validarFirmaWebhookMp(datos),true);
  assert.equal(validarFirmaWebhookMp({...datos,dataId:'101'}),false);
  assert.equal(validarFirmaWebhookMp({...datos,secret:'incorrecto'}),false);
  assert.equal(validarFirmaWebhookMp({...datos,ahora:ahora+11*60_000}),false);
  assert.equal(validarFirmaWebhookMp({...datos,signature:'ts=0,v1='+firma}),false);
  assert.equal(validarFirmaWebhookMp({...datos,requestId:''}),false);
});
test('autorización no es pago: exige dos recursos remotos aprobados y MXN150',()=>{
  assert.equal(validarCobroSaas({factura:factura(),pago:pago(),preapprovalId:'MP-CORRECT'}),true);
  assert.equal(validarCobroSaas({factura:factura(),pago:{...pago(),status:'pending'},preapprovalId:'MP-CORRECT'}),false);
  assert.equal(validarCobroSaas({factura:{...factura(),transaction_amount:1},pago:pago(),preapprovalId:'MP-CORRECT'}),false);
  assert.equal(validarCobroSaas({factura:factura(),pago:{...pago(),currency_id:'USD'},preapprovalId:'MP-CORRECT'}),false);
  assert.equal(validarCobroSaas({factura:factura(),pago:pago(),preapprovalId:'MP-OTRO'}),false);
  assert.equal(validarCobroSaas({factura:factura(),pago:{...pago(),id:999},preapprovalId:'MP-CORRECT'}),false);
  assert.equal(validarCobroSaas({factura:factura(),pago:{...pago(),date_approved:null},preapprovalId:'MP-CORRECT'}),false);
});
test('API remota: rutas cerradas, no acepta host externo y usa credencial SaaS',async()=>{
  const anterior=process.env.MP_SAAS_ACCESS_TOKEN;
  process.env.MP_SAAS_ACCESS_TOKEN='TOKEN-MOCK';
  try{
    await assert.rejects(consultarMpSaas('https://malicioso.example/api'));
    await assert.rejects(consultarMpSaas('/v1/payments/123?otro=1'));
    const calls=[];
    const salida=await consultarMpSaas('/preapproval',{
      method:'POST',body:{status:'pending'},
      fetchImpl:async(url,opts)=>{
        calls.push({url,opts});
        return {ok:true,json:async()=>({id:'abc'})};
      },
    });
    assert.equal(salida.id,'abc');
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,'https://api.mercadopago.com/preapproval');
    assert.equal(calls[0].opts.headers.Authorization,'Bearer TOKEN-MOCK');
  }finally{
    if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;
    else process.env.MP_SAAS_ACCESS_TOKEN=anterior;
  }
});

test('la integración queda APAGADA sin configuración explícita',()=>{
  const old=process.env.XABOR_SUSCRIPCIONES_MP;
  delete process.env.XABOR_SUSCRIPCIONES_MP;
  try{assert.equal(mpSaasHabilitado(),false);}
  finally {if(old!==undefined)process.env.XABOR_SUSCRIPCIONES_MP=old;}
});

test('rechazos definidos permiten reintentar; respuestas inciertas no liberan un contrato',async()=>{
  const anterior=process.env.MP_SAAS_ACCESS_TOKEN;
  process.env.MP_SAAS_ACCESS_TOKEN='QA_CREDENCIAL_NO_REAL';
  try{
    for(const status of [400,401,403,404,405,422,408,409,425,429,500,503]){
      await assert.rejects(consultarMpSaas('/preapproval',{method:'POST',body:{},
        fetchImpl:async()=>new Response('No se debe exponer este detalle del proveedor',{status})}),e=>{
          assert.equal(e.rechazoDefinitivo,[400,401,403,404,405,422].includes(status));
          assert(!e.message.includes('detalle del proveedor'));return true;
        });
    }
    await assert.rejects(consultarMpSaas('/preapproval',{method:'POST',body:{},fetchImpl:async()=>{throw Error('timeout');}}),e=>e.rechazoDefinitivo===false);
  }finally{if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;else process.env.MP_SAAS_ACCESS_TOKEN=anterior;}
});

test('busca facturas por ID numérico de pago y por contrato',async()=>{
  const anterior=process.env.MP_SAAS_ACCESS_TOKEN;
  process.env.MP_SAAS_ACCESS_TOKEN='TOKEN-MOCK';
  const urls=[];
  const opciones={fetchImpl:async url=>{
    urls.push(url);
    return {ok:true,json:async()=>({results:[factura(),{...factura(),payment:{id:999}}]})};
  }};
  try {
    assert.equal((await buscarFacturaMpSaasPorPago('200',opciones)).length,1);
    assert.equal((await buscarFacturasMpSaasPorContrato('MP-CORRECT',opciones)).length,2);
    assert.deepEqual(urls,[
      'https://api.mercadopago.com/authorized_payments/search?payment_id=200',
      'https://api.mercadopago.com/authorized_payments/search?preapproval_id=MP-CORRECT&limit=20&offset=0',
    ]);
    await assert.rejects(buscarFacturaMpSaasPorPago('200&otro=1',opciones));
  } finally {
    if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;
    else process.env.MP_SAAS_ACCESS_TOKEN=anterior;
  }
});

test('rutas requieren firma y no aceptan monto o negocio del webhook',()=>{
  const rutas=readFileSync(new URL('../src/services/suscripcionBasicoMpRutas.js',import.meta.url),'utf8');
  const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  assert.match(rutas,/validarFirmaWebhookMp/);
  assert.match(rutas,/requireSesionNegocio\('admin'\)/);
  assert.match(rutas,/conciliarPagoNotificadoMercadoPago/);
  assert.match(server,/webhook\/xabor-saas-mp/);
  assert.match(server,/\/api\/suscripciones-basico\/estado/);
  assert.match(server,/res\.redirect\(302, '\/suscripcion-basico'\)/);
});

test('cancelación: exige contrato de la propia cuenta y confirmación remota',()=>{
  const service=readFileSync(new URL('../src/services/suscripcionBasicoMp.js',import.meta.url),'utf8');
  const routes=readFileSync(new URL('../src/services/suscripcionBasicoMpRutas.js',import.meta.url),'utf8');
  assert.match(service,/SELECT negocio_id, external_reference, preapproval_id, estado_mp/);
  assert.match(service,/WHERE negocio_id = \$1/);
  assert.match(service,/antes\?\.external_reference !== local\.external_reference/);
  assert.match(service,/No se borra el histórico/);
  assert.match(routes,/exigirAccion\('cancelar'\)/);
  assert.match(routes,/X-Xabor-Accion/);
});
test('front-end de cobros tiene JS válido y exige confirmación al cancelar',()=>{
  const html=readFileSync(new URL('../panel/suscripcion-basico.html',import.meta.url),'utf8');
  const script=html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(()=>new Function(script[1]));
  assert.match(script[1],/window\.confirm/);
  assert.match(script[1],/X-Xabor-Accion/);
});
test('reconciliación de webhooks perdidos exige permiso explícito',()=>{
  const codigo=readFileSync(new URL('../scripts/conciliar-billing-basico-mp.mjs',import.meta.url),'utf8');
  assert.match(codigo,/XABOR_CONCILIACION_CONFIRMADA !== 'SI'/);
  assert.match(codigo,/XABOR_SUSCRIPCIONES_MP !== 'true'/);
  assert.match(codigo,/conciliarFacturaMercadoPago/);
});
