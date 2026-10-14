// Regresión sin producción: navegador local, routing puro y validación previa a DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import puppeteer from 'puppeteer';
import { registrarPago } from '../src/services/restauranteService.js';
import { pool } from '../src/services/database.js';
import { propinasPorClase } from '../src/services/cortesCaja.js';
import { indexarReglas, agruparItemsPorImpresora } from '../src/printing/routingEngine.js';

let pasadas = 0;
async function t(nombre, fn) { await fn(); console.log('OK ' + nombre); pasadas++; }
const html = readFileSync(new URL('../panel/mesas.html', import.meta.url), 'utf8');
for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
const funciones = html.slice(html.indexOf('function lineasDePago()'), html.indexOf('async function registrarPago()'));
const enviar = html.slice(html.indexOf('async function enviarComanda()'), html.indexOf('// ─── Quitar o cambiar'));
const browser = await puppeteer.launch({headless:true,args:['--no-sandbox']});
try {
 const page = await browser.newPage();
 await page.setRequestInterception(true);
 page.on('request', req => req.abort());
 await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
 await page.addScriptTag({content:`
 const $ = id => document.getElementById(id);
 const money = n => '$'+Number(n||0).toFixed(2);
 const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let PAGO_CTX = {tipo:'consumo'}, CUENTA = {id:'local'};
 let respuestaComanda, ultimoMensaje;
 const api = async () => respuestaComanda;
 const msg = s => ultimoMensaje = s;
 const refrescarCuenta = async () => {};
 ${funciones}\n${enviar}
 `});
 async function escenario({primero='terminal',segundo='efectivo',propinaMetodo='terminal',mixto=true,recibido='200',propina='20'}={}) {
  return page.evaluate(o => {
   $('pg-monto').value='300'; $('pg-mixto').checked=o.mixto;
   $('pg-metodo').value=o.primero; $('pg-metodo2').value=o.segundo;
   $('pg-monto2').value='100'; $('pg-recibido').value=o.recibido; $('pg-propina').value=o.propina;
   actualizarCambio(); $('pg-propina-metodo').value=o.propinaMetodo; actualizarCambio();
   return { ...lineasDePago(), texto:$('pg-cambio').textContent,disabled:$('pg-registrar').disabled };
  },{primero,segundo,propinaMetodo,mixto,recibido,propina});
 }
 await t('Mixto: propina en tarjeta no disminuye el cambio en efectivo', async()=>{
  const r=await escenario(); assert.equal(r.texto,'Cambio: $100.00');
  assert.equal(Number(r.lineas[0].propina),20); assert.equal(Number(r.lineas[1].propina),0);
  assert.equal(propinasPorClase({pagos:r.lineas}).tarjeta,20);
 });
 await t('Mixto: elegir propina en efectivo cambia registro y cambio juntos', async()=>{
  const r=await escenario({propinaMetodo:'efectivo'}); assert.equal(r.texto,'Cambio: $80.00');
  assert.equal(Number(r.lineas[0].propina),0); assert.equal(Number(r.lineas[1].propina),20);
  assert.equal(propinasPorClase({pagos:r.lineas}).efectivo,20);
 });
 await t('Mixto con efectivo primero conserva el cálculo', async()=>{
  const r=await escenario({primero:'efectivo',segundo:'terminal',propinaMetodo:'efectivo',recibido:'300'});
  assert.equal(r.texto,'Cambio: $80.00'); assert.equal(Number(r.lineas[0].propina),20);
 });
 await t('Efectivo insuficiente solo incluye la propina del efectivo', async()=>{
  assert.equal((await escenario({propinaMetodo:'efectivo',recibido:'110'})).disabled,true);
  assert.equal((await escenario({propinaMetodo:'terminal',recibido:'110'})).texto,'Cambio: $10.00');
 });
 await t('Pago simple conserva importe y propina',async()=>{
  const r=await escenario({mixto:false,primero:'efectivo',recibido:'500'});
  assert.equal(r.texto,'Cambio: $180.00'); assert.equal(r.lineas.length,1);
 });
 await t('Comanda sin trabajos informa falta de impresión',async()=>{
  const s=await page.evaluate(async()=>{respuestaComanda={comanda:1,items:[{}],impresion:{trabajos:0,avisos:[]}};await enviarComanda();return ultimoMensaje;});
  assert.ok(s.includes('No se generaron trabajos')); assert.ok(!s.includes('enviada a cocina'));
 });
 await t('Trabajo creado se describe como en cola, sin afirmar impresión física',async()=>{
  const s=await page.evaluate(async()=>{respuestaComanda={comanda:2,items:[{}],impresion:{trabajos:1,avisos:[]}};await enviarComanda();return ultimoMensaje;});
  assert.ok(s.includes('En cola de impresión'));
 });
 await t('Error al preparar impresión queda visible',async()=>{
  const s=await page.evaluate(async()=>{respuestaComanda={comanda:3,items:[{}],impresion:{trabajos:0,error:'ERROR_IMPRESION',avisos:[]}};await enviarComanda();return ultimoMensaje;});
  assert.ok(s.includes('No se pudo preparar'));
 });
 await t('Propina inválida se rechaza antes de abrir conexión a DB',async()=>{
  for(const propina of ['abc',Infinity,-1]) await assert.rejects(registrarPago('local','local',{metodo:'efectivo',monto:100,propina},'local'),{code:'MONTO_INVALIDO'});
 });
 await t('Reglas de categorías antiguas prevalecen sobre la impresora nueva',()=>{
  const reglas=[{ambito:'categoria',clave:'chilaquiles',impresora_id:'antigua'},{ambito:'documento',clave:'comanda',impresora_id:'actual'}];
  const items=[{producto:'Chilaquiles',categoria:'chilaquiles',cantidad:1}];
  assert.equal(agruparItemsPorImpresora(items,indexarReglas(reglas)).grupos[0].impresoraId,'antigua');
  assert.equal(agruparItemsPorImpresora(items,indexarReglas(reglas.filter(r=>r.impresora_id!=='antigua'))).grupos[0].impresoraId,'actual');
 });
 console.log(`${pasadas} pruebas pasadas; sin conexión a producción ni impresión física.`);
} finally {await browser.close();await pool.end();}
