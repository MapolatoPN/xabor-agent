import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PRECIO_SAAS_MXN, construirPreapprovalBasico, enlaceMPValido,
  validarFirmaWebhookMp, validarCobroSaas, consultarMpSaas,
  mpSaasHabilitado, verificarCuentaMpSaas, validarCorreoPagadorMpSaas, crearPreapprovalBasico,
  buscarFacturaMpSaasPorPago, buscarFacturasMpSaasPorContrato, cancelarPreapprovalBasico,
} from '../src/services/mercadoPagoSaasCliente.js';

process.env.MP_SAAS_MODO='prueba';
process.env.MP_SAAS_VENDEDOR_ID='10001';
const perfilPrueba={id:10001,site_id:'MLM',tags:['test_user'],email:'vendedor@ejemplo.invalid'};
const conCuentaPrueba=respuesta=>async(url,opciones)=>url==='https://api.mercadopago.com/users/me'
  ? new Response(JSON.stringify(perfilPrueba)) : respuesta(url,opciones);

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

test('cancelación: envía cancelled con PUT y valida la confirmación del proveedor',async()=>{
  const anterior=process.env.MP_SAAS_ACCESS_TOKEN;
  process.env.MP_SAAS_ACCESS_TOKEN='QA_CANCELACION_NO_REAL';
  try{
    const llamadas=[];
    const r=await cancelarPreapprovalBasico('MP-CANCELAR',{
      fetchImpl:conCuentaPrueba(async(url,opciones)=>{
        llamadas.push({url,method:opciones.method,body:JSON.parse(opciones.body)});
        if(JSON.parse(opciones.body).status!=='cancelled')return new Response('{}',{status:400});
        return new Response(JSON.stringify({id:'MP-CANCELAR',collector_id:10001,status:'cancelled'}));
      }),
    });
    assert.equal(r.status,'cancelled');
    assert.deepEqual(llamadas,[{url:'https://api.mercadopago.com/preapproval/MP-CANCELAR',method:'PUT',body:{status:'cancelled'}}]);
  }finally{if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;else process.env.MP_SAAS_ACCESS_TOKEN=anterior;}
});

test('cancelación: un rechazo, timeout o confirmación inválida nunca se considera éxito',async()=>{
  const anterior=process.env.MP_SAAS_ACCESS_TOKEN;
  process.env.MP_SAAS_ACCESS_TOKEN='QA_CANCELACION_NO_REAL';
  try{
    for(const dato of [
      {id:'OTRO',collector_id:10001,status:'cancelled'},
      {id:'MP-CANCELAR',collector_id:10001,status:'authorized'},
      {id:'MP-CANCELAR',collector_id:99999,status:'cancelled'},
    ])await assert.rejects(cancelarPreapprovalBasico('MP-CANCELAR',{fetchImpl:conCuentaPrueba(async()=>new Response(JSON.stringify(dato)))}));
    for(const status of [400,500])await assert.rejects(cancelarPreapprovalBasico('MP-CANCELAR',{
      fetchImpl:conCuentaPrueba(async()=>new Response('DETALLE_PRIVADO',{status})),
    }),e=>!e.message.includes('DETALLE_PRIVADO'));
    await assert.rejects(cancelarPreapprovalBasico('MP-CANCELAR',{
      fetchImpl:conCuentaPrueba(async()=>{throw Error('timeout');}),
    }),e=>e.estado===503);
  }finally{if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;else process.env.MP_SAAS_ACCESS_TOKEN=anterior;}
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

test('correo de pago: normaliza la cuenta compradora y mantiene privado al vendedor',async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify(perfilPrueba));
  assert.equal(await validarCorreoPagadorMpSaas(' COMPRADOR@Ejemplo.invalid ',{env:entornoPrueba,fetchImpl}),'comprador@ejemplo.invalid');
  assert.deepEqual(await verificarCuentaMpSaas({env:entornoPrueba,fetchImpl}),{modo:'prueba',vendedorVerificado:true,pais:'MLM'});
  for(const correo of ['',null,{},'a@@ejemplo.invalid','a b@ejemplo.invalid','a'.repeat(255)+'@ejemplo.invalid']){
    await assert.rejects(validarCorreoPagadorMpSaas(correo,{env:entornoPrueba,fetchImpl}),e=>e.estado===400&&e.rechazoDefinitivo);
  }
  await assert.rejects(validarCorreoPagadorMpSaas(' VENDEDOR@EJEMPLO.INVALID ',{env:entornoPrueba,fetchImpl}),e=>{
    assert(!e.message.includes(perfilPrueba.email));return e.estado===400&&e.rechazoDefinitivo;
  });
  await assert.rejects(validarCorreoPagadorMpSaas('comprador@ejemplo.invalid',{env:entornoPrueba,
    fetchImpl:async()=>new Response(JSON.stringify({...perfilPrueba,email:undefined}))}),e=>e.estado===503);
});

test('el cliente nunca envía POST si comprador y vendedor son la misma cuenta',async()=>{
  const anterior=process.env.MP_SAAS_ACCESS_TOKEN;process.env.MP_SAAS_ACCESS_TOKEN='QA_TOKEN_SELF_PAYMENT';
  const llamadas=[];
  try{
    await assert.rejects(crearPreapprovalBasico({negocioId,email:'VENDEDOR@EJEMPLO.INVALID',
      inicioCobro:'2026-11-30T12:00:00Z',baseUrl:'https://xabor.mx'},
      {fetchImpl:async url=>{llamadas.push(url);return new Response(JSON.stringify(perfilPrueba));}}),e=>e.estado===400);
    assert.deepEqual(llamadas,['https://api.mercadopago.com/users/me']);
  }finally{if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;else process.env.MP_SAAS_ACCESS_TOKEN=anterior;}
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
      fetchImpl:conCuentaPrueba(async(url,opts)=>{
        calls.push({url,opts});
        return {ok:true,json:async()=>({id:'abc',collector_id:10001})};
      }),
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
        fetchImpl:conCuentaPrueba(async()=>new Response('No se debe exponer este detalle del proveedor',{status}))}),e=>{
          assert.equal(e.rechazoDefinitivo,[400,401,403,404,405,422].includes(status));
          assert(!e.message.includes('detalle del proveedor'));return true;
        });
    }
    await assert.rejects(consultarMpSaas('/preapproval',{method:'POST',body:{},fetchImpl:conCuentaPrueba(async()=>{throw Error('timeout');})}),e=>e.rechazoDefinitivo===false);
  }finally{if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;else process.env.MP_SAAS_ACCESS_TOKEN=anterior;}
});

test('busca facturas por ID numérico de pago y por contrato',async()=>{
  const anterior=process.env.MP_SAAS_ACCESS_TOKEN;
  process.env.MP_SAAS_ACCESS_TOKEN='TOKEN-MOCK';
  const urls=[];
  const opciones={fetchImpl:conCuentaPrueba(async url=>{
    urls.push(url);
    return {ok:true,json:async()=>({results:[factura(),{...factura(),payment:{id:999}}]})};
  })};
  try {
    assert.equal((await buscarFacturaMpSaasPorPago('200',opciones)).length,1);
    assert.equal((await buscarFacturasMpSaasPorContrato('MP-CORRECT',opciones)).length,2);
    assert.deepEqual(urls,[
      'https://api.mercadopago.com/authorized_payments/search?payment_id=200',
      'https://api.mercadopago.com/authorized_payments/search?preapproval_id=MP-CORRECT&limit=12&offset=0',
    ]);
    await assert.rejects(buscarFacturaMpSaasPorPago('200&otro=1',opciones));
    await assert.rejects(buscarFacturasMpSaasPorContrato('MP-CORRECT',{...opciones,limit:20}));
  } finally {
    if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;
    else process.env.MP_SAAS_ACCESS_TOKEN=anterior;
  }
});

const entornoPrueba={XABOR_SUSCRIPCIONES_MP:'true',MP_SAAS_ACCESS_TOKEN:'QA_TOKEN_SIN_DINERO',
  MP_SAAS_WEBHOOK_SECRET:'QA_FIRMA',MP_SAAS_MODO:'prueba',MP_SAAS_VENDEDOR_ID:'10001',RAILWAY_ENVIRONMENT_NAME:'staging-basico'};

test('modo y vendedor son explícitos; staging no admite producción ni producción admite prueba',()=>{
  assert.equal(mpSaasHabilitado(entornoPrueba),true);
  for(const cambio of [{MP_SAAS_MODO:undefined},{MP_SAAS_VENDEDOR_ID:undefined},{MP_SAAS_VENDEDOR_ID:'otro'},
    {MP_SAAS_MODO:'produccion'},{RAILWAY_ENVIRONMENT_NAME:'production'}]) {
    assert.equal(mpSaasHabilitado({...entornoPrueba,...cambio}),false);
  }
  assert.equal(mpSaasHabilitado({...entornoPrueba,MP_SAAS_MODO:'produccion',RAILWAY_ENVIRONMENT_NAME:'production'}),true);
});

test('cuenta equivocada o real en modo prueba se rechaza antes del POST',async()=>{
  const anterior=process.env.MP_SAAS_ACCESS_TOKEN;process.env.MP_SAAS_ACCESS_TOKEN='QA_TOKEN_PREFLIGHT';
  try {
    for(const perfil of [{...perfilPrueba,id:20002},{...perfilPrueba,site_id:'MLA'},
      {...perfilPrueba,tags:[]},{...perfilPrueba,tags:null}]) {
      const llamadas=[];
      await assert.rejects(consultarMpSaas('/preapproval',{method:'POST',body:{},fetchImpl:async url=>{
        llamadas.push(url);return new Response(JSON.stringify(perfil));
      }}),e=>e.rechazoDefinitivo===true);
      assert.deepEqual(llamadas,['https://api.mercadopago.com/users/me']);
    }
    await assert.rejects(verificarCuentaMpSaas({env:entornoPrueba,fetchImpl:async()=>new Response('DETALLE_PRIVADO',{status:401})}),e=>{
      assert.equal(e.message.includes('DETALLE_PRIVADO'),false);return e.rechazoDefinitivo===true;
    });
  } finally {if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;else process.env.MP_SAAS_ACCESS_TOKEN=anterior;}
});

test('verificación concurrente se comparte y una credencial distinta vuelve a verificarse',async()=>{
  let consultas=0;
  const fetchImpl=async()=>{consultas++;return new Response(JSON.stringify(perfilPrueba));};
  const rs=await Promise.all([1,2,3].map(()=>verificarCuentaMpSaas({env:entornoPrueba,fetchImpl})));
  assert.equal(consultas,1);assert(rs.every(r=>r.vendedorVerificado&&r.modo==='prueba'));
  await verificarCuentaMpSaas({env:{...entornoPrueba,MP_SAAS_ACCESS_TOKEN:'QA_TOKEN_ROTADO'},fetchImpl});
  assert.equal(consultas,2);
});

test('respuesta de otro vendedor o pago de otro ambiente no se acepta',async()=>{
  const anterior=process.env.MP_SAAS_ACCESS_TOKEN;process.env.MP_SAAS_ACCESS_TOKEN='QA_TOKEN_RESPUESTA';
  try {
    await assert.rejects(consultarMpSaas('/preapproval',{method:'POST',body:{},
      fetchImpl:conCuentaPrueba(async()=>new Response(JSON.stringify({collector_id:20002})))}),e=>e.rechazoDefinitivo===false);
    await assert.rejects(consultarMpSaas('/v1/payments/200',{
      fetchImpl:conCuentaPrueba(async()=>new Response(JSON.stringify({collector_id:10001,live_mode:true})))}));
    const pago=await consultarMpSaas('/v1/payments/200',{
      fetchImpl:conCuentaPrueba(async()=>new Response(JSON.stringify({collector_id:10001,live_mode:false})))});
    assert.equal(pago.live_mode,false);
  } finally {if(anterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;else process.env.MP_SAAS_ACCESS_TOKEN=anterior;}
});

test('producción verifica un vendedor real; una cuenta de prueba no se convierte por el prefijo del token',async()=>{
  const env={...entornoPrueba,MP_SAAS_MODO:'produccion',RAILWAY_ENVIRONMENT_NAME:'production'};
  await assert.rejects(verificarCuentaMpSaas({env,fetchImpl:async()=>new Response(JSON.stringify(perfilPrueba))}));
  const r=await verificarCuentaMpSaas({env,fetchImpl:async()=>new Response(JSON.stringify({...perfilPrueba,tags:['normal']}))});
  assert.equal(r.modo,'produccion');assert.equal(r.vendedorVerificado,true);
  let consulto=false;
  await assert.rejects(verificarCuentaMpSaas({env:{...env,MP_SAAS_MODO:undefined},fetchImpl:async()=>{consulto=true;}}));
  assert.equal(consulto,false);
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
