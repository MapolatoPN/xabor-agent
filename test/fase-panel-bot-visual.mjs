// Requiere el preview local: node test/fase-panel-bot-formularios.mjs --preview
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdtemp,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const carpeta=await mkdtemp(join(tmpdir(),'xabor-panel-bot-qa-'));
const browser=await puppeteer.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request',r=>new URL(r.url()).hostname==='127.0.0.1'?r.continue():r.abort());
  for(const width of [1200,390,320]) {
    await page.setViewport({width,height:1000,deviceScaleFactor:1});
    await page.goto('http://127.0.0.1:55981',{waitUntil:'networkidle0'});
    assert.equal(await page.locator('h1').waitHandle().then(h=>h.evaluate(e=>e.textContent)),'Revisión local · Bot y formularios');
    assert(await page.evaluate(()=>document.body.textContent.includes('Piloto activo')));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`sin desborde horizontal a ${width}px`);
    assert(await page.evaluate(()=>document.querySelector('.chat-botcard-txt').getBoundingClientRect().width>=180),'estado legible sin comprimir palabras');
    assert(await page.evaluate(()=>document.querySelector('.chat-burbuja').getBoundingClientRect().width>=200),'tarjeta legible');
    await page.click('summary');
    assert(await page.evaluate(()=>document.querySelector('details').open));
    const ruta=join(carpeta,`panel-${width}.png`);
    await page.screenshot({path:ruta,fullPage:true});console.log(ruta);
  }
  const fuente=await readFile(new URL('../panel/index.html',import.meta.url),'utf8');
  const nombres=['esc','escaparHTML','textoWhatsAppHTML','contenidoTarjetaFormulario','contenidoBurbujaMensaje','etiquetaOrigen','horaBurbuja','burbujaMensajeHTML','actualizarHistorialChat'];
  const funciones=nombres.map(n=>[...fuente.matchAll(new RegExp(`^(?:async )?function ${n}\\([^]*?^}`, 'gm'))].at(-1)[0]).join('\n');
  await page.setContent('<div id="tab-chats" class="activo"></div><div id="chat-mensajes"></div><textarea id="chat-input">Borrador del operador</textarea>');
  await page.addScriptTag({content:`let chatAbierto='local',actualizacionChatEnCurso=false;function programarActualizacionChat(){};${funciones}`});
  const resultado=await page.evaluate(async()=>{
    const inicial={id:1,direccion:'entrante',texto:'Formulario recibido',timestamp:new Date().toISOString()};
    const guardado={...inicial,interaccion:{tipo:'formulario',titulo:'Cambios guardados',detalle:'Validado',resumen:'*Pedido*\nSin crema'}};
    window.apiFetch=async()=>({ok:true,json:async()=>[guardado]});
    document.getElementById('chat-mensajes').innerHTML=burbujaMensajeHTML(inicial);
    await actualizarHistorialChat();
    document.querySelector('details').open=true;
    const nodo=document.querySelector('[data-mensaje-id]');
    await actualizarHistorialChat();
    const estable=nodo===document.querySelector('[data-mensaje-id]');
    window.apiFetch=async()=>{throw Error('sin conexión');};await actualizarHistorialChat();
    return {estable,abierto:document.querySelector('details').open,cantidad:document.querySelectorAll('[data-mensaje-id]').length,
      texto:document.body.textContent,borrador:document.getElementById('chat-input').value};
  });
  assert(resultado.estable);assert(resultado.abierto);assert.equal(resultado.cantidad,1);
  assert.match(resultado.texto,/Cambios guardados/);assert.equal(resultado.borrador,'Borrador del operador');
  console.log('OK visual local: 1200/390/320 px, sin desborde; resultado guardado desplegable.');
  console.log('OK DOM real: actualización sin duplicar, detalle abierto sin recrearse, texto del operador y resultado conservados tras error de red.');
} finally {await browser.close();}
