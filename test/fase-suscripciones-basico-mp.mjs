import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  PRECIO_SAAS_MXN, construirPreapprovalBasico, enlaceMPValido,
  validarFirmaWebhookMp, validarCobroSaas, consultarMpSaas,
  mpSaasHabilitado,
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

test('ledger: el webhook duplicado solo acredita una mensualidad',async()=>{
  const src=readFileSync(new URL('../src/services/suscripcionBasicoMp.js',import.meta.url),'utf8');
  const moduleSource=src
    .replace("import { pool } from './database.js';","const pool = globalThis.__poolMpTest;")
    .replace(/import \{[\s\S]*?\} from '\.\/mercadoPagoSaasCliente\.js';/,
      'const { crearPreapprovalBasico, obtenerPreapprovalBasico, obtenerFacturaMpSaas, obtenerPagoMpSaas, buscarFacturaMpSaasPorPago, validarCobroSaas, enlaceMPValido, PRECIO_SAAS_MXN } = globalThis.__depsMpTest;');
  const state={pagos:0,meses:0};
  globalThis.__depsMpTest={
    crearPreapprovalBasico:()=>{},obtenerPreapprovalBasico:()=>{},
    obtenerFacturaMpSaas:()=>{},obtenerPagoMpSaas:()=>{},
    buscarFacturaMpSaasPorPago:()=>{},validarCobroSaas,enlaceMPValido,PRECIO_SAAS_MXN,
  };
  globalThis.__poolMpTest={
    query:async(sql,args)=>{
      if(sql.includes('FROM suscripciones_basico_mp WHERE preapproval_id')){
        return {rows:args[0]==='MP-CORRECT'?[{negocio_id:negocioId,external_reference:referencia}]:[]};
      }
      throw Error('Consulta inesperada '+sql);
    },
    connect:async()=>({
      query:async(sql,args)=>{
        if(['BEGIN','ROLLBACK','COMMIT'].includes(sql))return {};
        if(sql.includes('INSERT INTO pagos_suscripcion_basico_mp')){
          if(state.pagos++)return {rows:[]};
          return {rows:[{id:'registro'}]};
        }
        if(sql.includes('UPDATE negocio_plan_comercial')){
          state.meses++;
          return {rowCount:1};
        }
        throw Error('SQL inesperado '+sql);
      },
      release:()=>{},
    }),
  };
  try{
    const mod=await import('data:text/javascript;charset=utf-8,'+encodeURIComponent(moduleSource));
    const args={
      obtenerFactura:async()=>factura(),obtenerPago:async()=>pago(),
      obtenerPreapproval:async()=>({id:'MP-CORRECT',external_reference:referencia}),
    };
    assert.deepEqual(await mod.conciliarFacturaMercadoPago('100',args),{aplicado:true});
    assert.deepEqual(await mod.conciliarFacturaMercadoPago('100',args),{aplicado:false,motivo:'ya_acreditado'});
    assert.equal(state.meses,1);
    assert.deepEqual(await mod.conciliarFacturaMercadoPago('100',{
      ...args,obtenerPreapproval:async()=>({id:'MP-CORRECT',external_reference:'otro-negocio'}),
    }),{aplicado:false,motivo:'cobro_no_verificado'});
    assert.equal(state.meses,1);
  }finally{delete globalThis.__depsMpTest;delete globalThis.__poolMpTest;}
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
