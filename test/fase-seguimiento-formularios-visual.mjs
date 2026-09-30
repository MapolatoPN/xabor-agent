import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import puppeteer from 'puppeteer';
import {seguimientoFormulario,vistaFormularioEnviado} from '../src/services/seguimientoFormulario.js';
const codigo=await readFile(new URL('../panel/formulariosChat.js',import.meta.url),'utf8');
const ahora=Date.parse('2026-09-30T16:00:00Z');
const seguimiento=seguimientoFormulario({estado:'disponible',created_at:'2026-09-30T15:40:00Z',
  eventos:[{tipo:'apertura',paso:'CARRITO',observado_at:'2026-09-30T15:40:20Z'},
    {tipo:'paso',paso:'EDITAR',observado_at:'2026-09-30T15:44:39Z'}]},{ahora});
const vista=vistaFormularioEnviado({tipo:'flow_configurar',version:'carrito_v1',lineas:[{ficha:{nombre:'Chilaquiles Mixtos',precio:205,
  grupos:[{nombre:'Salsa',minimo:1,maximo:2,opciones:[{nombre:'Roja',precio:0},{nombre:'Verde',precio:0}]},
    {nombre:'Proteína',minimo:1,maximo:2,opciones:[{nombre:'Pechuga de pollo',precio:0},{nombre:'Bistec en salsa',precio:30}]}]}}],
  modalidades:[{titulo:'Recoger en tienda'},{titulo:'Entrega a domicilio'}],pagos:[{titulo:'Efectivo'}]});
const browser=await puppeteer.launch({headless:true,args:['--no-sandbox']});
try {
  const p=await browser.newPage();let peticiones=0;
  await p.setRequestInterception(true);p.on('request',r=>{peticiones++;r.abort();});
  for(const width of [1200,390,320]) {
    await p.setViewport({width,height:900,deviceScaleFactor:1});
    await p.setContent('<html lang="es"><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#f4f6f8;font:16px Arial;box-sizing:border-box}main{box-sizing:border-box;width:100%;max-width:490px;padding:16px;margin:auto;background:#fff4ed;border:1px solid #ffe0cc;border-radius:16px;overflow-wrap:anywhere}h1{font-size:18px;margin:0 0 8px}summary{line-height:1.6}</style><main><h1>Tu carrito</h1><div id="card"></div></main></html>');
    await p.addScriptTag({content:codigo});
    await p.evaluate(({seguimiento,vista})=>{document.querySelector('#card').innerHTML=
      FormulariosChat.seguimiento(seguimiento)+FormulariosChat.formulario(vista);},{seguimiento,vista});
    await p.click('summary');await p.click('details details summary');
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`desborde ${width}`);
    assert(await p.evaluate(()=>document.body.textContent.includes('sin actividad reciente')));
    assert(await p.evaluate(()=>document.querySelector('details details').open));
    assert.equal(await p.evaluate(()=>document.querySelectorAll('button,input,form').length),0);
    if(process.env.QA_CAPTURAS)await p.screenshot({path:`${process.env.QA_CAPTURAS}/seguimiento-${width}.png`,fullPage:true});
  }
  assert.equal(peticiones,0,'inspeccionar no contacta Meta ni el backend');
  console.log('OK vista aislada de seguimiento: 1200/390/320 px, sin desbordes, detalles legibles, cero peticiones/efectos. No certifica integración en panel.');
} finally {await browser.close();}
