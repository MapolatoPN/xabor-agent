// Compatibilidad del runtime y las API usadas por las pruebas de navegador.
// Sin base de datos, mensajes, archivos de clientes ni acceso a red.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const [mayor,menor]=process.versions.node.split('.').map(Number);
assert(mayor===22 && menor>=12,`Ejecuta esta suite con Node 22 >=22.12.0, no ${process.version}`);
await access(await puppeteer.executablePath());
assert(Array.isArray(await puppeteer.defaultArgs({headless:true})));
const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
  assert.equal(browser.connected,true);
  const context=await browser.createBrowserContext();
  try {
    const page=await context.newPage();
    await page.setRequestInterception(true);
    page.on('request',r=>r.abort());
    await page.setContent('<input id="buscar" value="Pedido anterior de prueba"><button id="continuar">Continuar</button>');
    // Puppeteer 25 retiró MouseOptions.clickCount; count es el contrato vigente.
    await page.click('#buscar',{count:3});
    await page.keyboard.type('Pedido nuevo');
    assert.equal(await page.$eval('#buscar',e=>e.value),'Pedido nuevo');
    await page.click('#continuar');
    assert.equal(await page.$eval('#continuar',e=>e===document.activeElement),true);
    console.log(`OK runtime: ${process.version}; ${await browser.version()}; rutas async, contexto, DOM y triple clic.`);
  } finally {await context.close();}
} finally {await browser.close();}
assert.equal(browser.connected,false);
console.log('OK runtime: contexto y proceso Chromium cerrados.');
