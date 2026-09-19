// Comprueba en Chromium el tamaño real del documento enviado a imprimir,
// incluso si el driver tiene seleccionado un rollo de 2 metros.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const html = readFileSync(new URL('../panel/mesas.html', import.meta.url), 'utf8');
const inicio = html.indexOf('function imprimirPrecuentaEnNavegador(');
const funcion = html.slice(inicio, html.indexOf('// ─── Dividir cuenta', inicio));
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({ headless:true, ...(existsSync(chrome) ? { executablePath:chrome } : {}) });
try {
  for (const cantidad of [1, 15, 50]) {
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    await page.evaluate(() => {
      window.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.money = n => '$' + Number(n || 0).toFixed(2);
      window.msg = () => {};
      const append = document.body.appendChild.bind(document.body);
      document.body.appendChild = frame => {
        const load = frame.onload;
        frame.onload = async () => {
          frame.contentWindow.print = () => { window.impresiones = (window.impresiones || 0) + 1; };
          await load();
        };
        return append(frame);
      };
    });
    await page.addScriptTag({ content:funcion });
    await page.evaluate(n => imprimirPrecuentaEnNavegador({ mesa:3, total:95*n,
      items:Array.from({length:n}, () => ({cantidad:1, producto:'Desayuno con salsa y guarnición', precioUnitario:95, notas:'Sin cebolla', modificadores:['Salsa: Verde']})) }), cantidad);
    await page.waitForFunction(() => window.impresiones === 1);
    const frame = page.frames().find(f => f !== page.mainFrame());
    const contenido = await frame.content();
    const impresion = await browser.newPage();
    await impresion.setContent(contenido);
    const pdf = Buffer.from(await impresion.pdf({width:'80mm', height:'2000mm', preferCSSPageSize:true}));
    const cajas = [...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/g)];
    assert.equal(cajas.length, 1, 'Una sola página de ticket, sin hojas extra');
    const altoMm = Number(cajas[0][2]) * 25.4 / 72;
    const anchoMm = Number(cajas[0][1]) * 25.4 / 72;
    assert.ok(Math.abs(anchoMm - 80) < 1);
    assert.ok(altoMm < 60 + cantidad*25, `Ticket de ${cantidad} items ocupa ${altoMm.toFixed(1)} mm`);
    const contenidoMm = await impresion.evaluate(() => document.body.getBoundingClientRect().height * 25.4/96);
    assert.ok(altoMm >= contenidoMm, 'El papel contiene todo el ticket');
    console.log(`OK ${cantidad} items: ${altoMm.toFixed(1)} mm, una impresión, una página`);
    await page.close();
    await impresion.close();
  }
} finally { await browser.close(); }
