// DOM y CSS reales del panel; datos sintéticos y toda red bloqueada.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const html=await readFile(new URL('../panel/index.html',import.meta.url),'utf8');
const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
const inicio=html.indexOf('<div class="chat-estado-card"');
const tarjeta=html.slice(inicio,html.indexOf('<div id="chat-mensajes">',inicio));
const fnInicio=html.indexOf('function actualizarBotonBot()');
const funcion=html.slice(fnInicio,html.indexOf('// Relee el estado',fnInicio));
const base={situacion:'verificado',pausado:false,pausaManual:false,botWhatsappActivo:true,requiereRevision:false,
  takeoverVigente:false,takeoverHasta:null};
const muestras=[
  ['temporal',{...base,takeoverVigente:true,takeoverHasta:'2026-09-30T15:30:00Z'},'Personal atendiendo desde WhatsApp'],
  ['manual',{...base,pausado:true,pausaManual:true},'Estás atendiendo esta conversación'],
  ['combinada',{...base,pausado:true,pausaManual:true,takeoverVigente:true,takeoverHasta:'2026-09-30T15:30:00Z'},'Estás atendiendo esta conversación'],
  ['desconocido',{situacion:'no_disponible'},'Estado de atención sin verificar'],
  ['automatico',base,'Atención automática habilitada'],
];
const carpeta=await mkdtemp(join(tmpdir(),'xabor-estado-atencion-qa-'));
const browser=await puppeteer.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
try {
  const page=await browser.newPage();
  await page.setRequestInterception(true);page.on('request',r=>r.abort());
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><style>${css}</style>${tarjeta}`);
  await page.addScriptTag({content:`let chatAbierto='local',estadoAtencionChat=null,cambiandoAtencionChat=false;${funcion}`});
  for(const width of [1200,390,320]) {
    await page.setViewport({width,height:800,deviceScaleFactor:1});
    for(const [nombre,estado,titulo] of muestras) {
      await page.evaluate(e=>{estadoAtencionChat=e;actualizarBotonBot();},estado);
      assert.equal(await page.$eval('#chat-atencion-estado',e=>e.textContent),titulo);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${nombre} a ${width}px`);
      const dimensiones=await page.$eval('#btn-toggle-bot',e=>({ancho:e.getBoundingClientRect().width,alto:e.getBoundingClientRect().height}));
      assert(dimensiones.ancho<=width && dimensiones.alto>=40);
      if(nombre==='desconocido')assert.equal(await page.$eval('#btn-toggle-bot',e=>e.disabled),true);
      if(nombre==='temporal' || nombre==='combinada') {
        await page.screenshot({path:join(carpeta,`${nombre}-${width}.png`),fullPage:true});
      }
    }
  }
  console.log(`OK DOM visual: 5 estados × 3 anchos, sin desborde, error sin acción. Capturas: ${carpeta}`);
} finally {await browser.close();}
