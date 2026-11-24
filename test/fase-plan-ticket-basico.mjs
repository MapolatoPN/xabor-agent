import test from 'node:test';
import assert from 'node:assert/strict';
import {precioBasicoMxn,diasGraciaBasico} from '../src/services/planBasico.js';
import {ticketVentaHtml} from '../src/services/ticketVentaBasico.js';
test('precio central configurable, nunca cero ni un valor ambiguo',()=>{
 assert.equal(precioBasicoMxn({}),150);assert.equal(precioBasicoMxn({XABOR_BASICO_MENSUALIDAD_MXN:'175.50'}),175.5);
 for(const n of ['0','-1','NaN','1e3','100.001',''])assert.throws(()=>precioBasicoMxn({XABOR_BASICO_MENSUALIDAD_MXN:n}));
});
test('gracia solo con duración explícita y acotada',()=>{
 assert.equal(diasGraciaBasico({}),0);assert.equal(diasGraciaBasico({XABOR_BASICO_GRACIA_DIAS:'3'}),3);
 assert.throws(()=>diasGraciaBasico({XABOR_BASICO_GRACIA_DIAS:'31'}));
});
test('ticket: datos escapados, importe persistido y orden sin cobro bien identificada',()=>{
 const html=ticketVentaHtml({negocio:'<script>alert(1)</script>',folio:'QA-1',estado:'nuevo',fecha:'2026-11-22T12:00:00Z',
  datos:{forma_pago:'por_cobrar',total:60,items:[{nombre:'<img src=x onerror=alert(1)>',cantidad:2,precio_unitario:30}]}});
 assert(!html.includes('<script>'));assert(!html.includes('<img'));assert(html.includes('Orden por cobrar'));
 assert(html.includes('$60.00'));assert(html.includes('No es una factura fiscal'));
});
