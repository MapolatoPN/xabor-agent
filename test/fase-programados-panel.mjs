// Navegador real, datos ficticios, GET y diálogo de impresión simulados.
// No conecta a producción ni a impresoras físicas.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import puppeteer from 'puppeteer';
import {programadoParaConsulta} from '../src/services/programadosConsulta.js';
const codigo=readFileSync(new URL('../panel/programados.js',import.meta.url),'utf8');
const p=programadoParaConsulta({folio:'XAB-LOCAL',negocio_id:'local',programado_id:'reserva-local',
  datos:{estado:'pendiente_pago',pago_confirmado:false,forma_pago:'enlace_pago',programado_para:'2026-10-10T13:45:00Z',
    cliente:{nombre:'Cliente de prueba',calle:'Calle local',numero_exterior:'10',colonia:'Centro'},
    items:[{cantidad:2,nombre:'Combito de Chilaquiles',precio_unitario:195,
      modificadores:[{grupo:'Salsa',opcion:'Suiza'}],notas:'Salsa: Suiza · Sin crema'}],
    subtotal:390,costo_envio:60,total:450,modalidad:'entrega a domicilio',notas:'Avisar en caseta'}},
  {nombre:'Mapolato de prueba'});
const browser=await puppeteer.launch({headless:true,pipe:true,args:['--no-sandbox','--disable-setuid-sandbox']});
try{
  const page=await browser.newPage();await page.setViewport({width:1080,height:700});
  await page.setRequestInterception(true);page.on('request',r=>r.abort());
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;background:#f6f4ef;padding:20px}#grid{display:flex;gap:12px;flex-wrap:wrap}</style></head><body><h2>Reservas y pedidos programados</h2><div id="wrap"><div id="grid"></div></div></body></html>');
  await page.addScriptTag({content:codigo});
  await page.evaluate(p=>{
    window.datosPrueba=p;window.prints=0;window.consultas=[];window.documentos=[];
    window.apiFetch=async(ruta,opciones)=>{window.consultas.push({ruta,opciones});return {ok:true,json:async()=>[{...p,estado_pago:'pagado',pago_confirmado:true}]};};
    window.open=()=>({closed:false,document:{write(t){window.documentos.push(t)},open(){},close(){}},focus(){},print(){window.prints++},close(){this.closed=true}});
    XaborProgramados.renderizar([p,{...p,folio:'XAB-PAGADO',estado_pago:'pagado',pago_confirmado:true},
      {...p,folio:'XAB-EFECTIVO',estado_pago:'al_recibir',forma_pago:'efectivo'}],document.getElementById('grid'),document.getElementById('wrap'));
  },p);
  assert.equal(await page.$$eval('button[data-programado-folio]',els=>els.length),3);
  const textos=await page.$eval('#grid',e=>e.textContent);
  for(const texto of ['RESERVA','Pendiente de pago','Pagado','Pago al recibir','Imprimir copia'])assert(textos.includes(texto),texto);
  const desbordes=await page.$$eval('article',els=>els.filter(e=>e.scrollWidth>e.clientWidth+1).length);assert.equal(desbordes,0);
  if(process.env.PROGRAMADOS_QA_DIR)await page.screenshot({path:process.env.PROGRAMADOS_QA_DIR+'/programados-preview.png',fullPage:true});
  await page.click('button[data-programado-folio="XAB-LOCAL"]');
  await page.waitForFunction(()=>window.prints===1);
  const r=await page.evaluate(()=>({consultas:window.consultas,html:window.documentos.at(-1),prints:window.prints}));
  assert.equal(r.consultas.length,1);assert.equal(r.consultas[0].ruta,'/api/pedidos-programados');assert.equal(r.consultas[0].opciones.cache,'no-store');
  assert(r.html.includes('PAGADO'));assert(!r.html.includes('PENDIENTE DE PAGO'));
  const copia=await browser.newPage();await copia.setViewport({width:470,height:900});
  await copia.setRequestInterception(true);copia.on('request',r=>r.abort());
  const textoCopia=await page.evaluate(p=>XaborProgramados.copiaHTML(p),p);await copia.setContent(textoCopia);
  assert.equal(await copia.$eval('body',e=>e.querySelectorAll('script').length),0);
  assert((await copia.$eval('body',e=>e.textContent)).includes('Sin crema'));
  if(process.env.PROGRAMADOS_QA_DIR)await copia.screenshot({path:process.env.PROGRAMADOS_QA_DIR+'/programados-copia-preview.png',fullPage:true});
  console.log('Panel programados: navegador real correcto; tres estados, copia manual con datos frescos y sin desbordes.');
}finally{await browser.close();}
