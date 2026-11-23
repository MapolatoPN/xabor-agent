// El formulario de campañas de WhatsApp en un navegador de verdad (Fase 0.1, 23-nov-2026).
//
// Lo que pidió Mario, visto desde la pantalla:
//   - Solo el hueco del nombre empieza como «El nombre del cliente»; los demás
//     empiezan como «Texto fijo» con su caja a la vista.
//   - Un texto vacío o con salto de línea/tabulador se marca junto a su campo
//     y no se llama al servidor.
//   - Sin nombre del cliente se propone «buen día».
//   - «Pausar si fallan más del (%) de los envíos».
//   - Programar fecha y hora: solo si el negocio tiene la bandera; la fecha
//     viaja al crear, y una programada se cancela desde el historial.
//
// No necesita Postgres ni red: carga panel/campanas-wa.js tal cual, con las
// plantillas analizadas por el analizarPlantilla del servidor y una API de
// juguete que anota cada llamada.
//
// Uso: node test/fase-campanas-wa-panel.mjs   (CASOS=F1,F6 para filtrar)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { analizarPlantilla, RESPALDO_NOMBRE, PROGRAMAR, HORARIO_ENVIO, SEGMENTOS, TANDAS } from '../src/services/campanasWaPlantillas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JS = readFileSync(join(__dirname, '..', 'panel', 'campanas-wa.js'), 'utf8');
const FILTRO = (process.env.CASOS || '').split(',').map(s => s.trim()).filter(Boolean);

// Plantillas como las devuelve la Graph API (forma real, datos inventados).
const PROMO = {
  id: '111', name: 'promo_jueves', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
  components: [
    { type: 'HEADER', format: 'TEXT', text: '¡{{1}} te espera!', example: { header_text: ['Xabor'] } },
    { type: 'BODY', text: 'Hola {{1}}, este jueves hay {{2}}.', example: { body_text: [['Ana', '2x1 en chilaquiles']] } },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Detener promociones' }] },
  ],
};
const SIN_NOMBRE = {
  id: '222', name: 'promo_sin_nombre', status: 'APPROVED', category: 'MARKETING', language: 'es_MX', parameter_format: 'NAMED',
  components: [{ type: 'BODY', text: 'Hoy hay {{promo}} en {{sucursal}}.',
    example: { body_text_named_params: [{ param_name: 'promo', example: '2x1' }, { param_name: 'sucursal', example: 'Obispado' }] } },
  { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Detener promociones' }] }],
};
const PLANTILLAS = [analizarPlantilla(PROMO), analizarPlantilla(SIN_NOMBRE)];
const AHORA_LOCAL = '2026-11-23T09:40';

function meta({ programar = false, respaldo = true } = {}) {
  return {
    conectado: true, numero: { calidad: 'GREEN', limite: 'TIER_1K' }, plantillas: PLANTILLAS, trazabilidad: true,
    segmentos: SEGMENTOS, horario: HORARIO_ENVIO, diasSinRepetir: 7, tandas: TANDAS,
    ...(respaldo ? { respaldoNombre: RESPALDO_NOMBRE } : {}),
    programar: programar ? { ...PROGRAMAR, ahoraLocal: AHORA_LOCAL } : null,
  };
}
const RESUMEN = { total: 3, excluidos: {}, vista: { cuerpo: 'Hola Ana, este jueves hay 2x1.' }, usaNombre: true, sinNombre: 0,
  tandas: { tope24h: 250, cuantas: 1, umbralRechazoPct: 10 }, costo: { totalUsd: 0.14, tarifaUsd: 0.045 }, categoria: 'MARKETING' };

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><body><div id="campanas-wa"></div></body>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_BASE = `http://127.0.0.1:${server.address().port}/`;

let pasadas = 0, fallidas = 0;
async function t(nombre, fn) {
  const clave = nombre.split(' ')[0].trim();
  if (FILTRO.length && !FILTRO.includes(clave)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const navegador = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await navegador.newPage();
const erroresPagina = [];
page.on('pageerror', e => erroresPagina.push(e.message));

// Abre la pestaña con lo que el servidor de juguete va a contestar.
async function abrir({ metaPlantillas = meta(), campanas = [] } = {}) {
  await page.goto(URL_BASE);
  await page.evaluate((m, campanas, resumen) => {
    window.__llamadas = [];
    window.__confirmaciones = [];
    window.confirm = (texto) => { window.__confirmaciones.push(texto); return true; };
    window.alert = () => {};
    const responder = (cuerpo, status = 200) => ({ status, ok: status < 400, json: async () => cuerpo });
    window.apiFetch = async (url, opciones = {}) => {
      const cuerpo = opciones.body ? JSON.parse(opciones.body) : null;
      window.__llamadas.push({ url, metodo: opciones.method || 'GET', cuerpo });
      if (url === '/api/admin/campanas-wa') return opciones.method === 'POST' ? responder({ ok: true, campanaId: 9 }) : responder({ campanas });
      if (url.startsWith('/api/admin/campanas-wa/plantillas')) return responder(m);
      if (url === '/api/admin/campanas-wa/vista-previa') return responder(resumen);
      if (/\/detener$/.test(url)) return responder({ ok: true });
      return responder({ error: 'ruta de juguete sin respuesta' }, 404);
    };
  }, metaPlantillas, campanas, RESUMEN);
  await page.addScriptTag({ content: JS });
  await page.evaluate(() => window.XaborCampanasWa.abrir(document.getElementById('campanas-wa')));
}
async function nuevaCampana(indice = '0') {
  await page.click('[data-acc="nueva"]');
  await page.waitForFunction(() => !document.getElementById('cwa-plantilla').disabled);
  await page.select('#cwa-plantilla', indice);
}
const ranura = (clave) => page.evaluate((clave) => {
  const c = document.querySelector(`[data-ranura="${clave}"]`);
  if (!c) return null;
  const caja = c.querySelector('[data-texto]');
  const error = c.querySelector('[data-error]');
  return { fuente: c.querySelector('[data-fuente]')?.value ?? null, cajaVisible: caja.style.display !== 'none',
    aviso: !!c.querySelector('[data-aviso-nombre]'), error: error.style.display === 'none' ? '' : error.textContent };
}, clave);
async function escribir(clave, texto) {
  await page.evaluate((clave, texto) => {
    const caja = document.querySelector(`[data-ranura="${clave}"] [data-texto]`);
    caja.value = texto;
    caja.dispatchEvent(new Event('input', { bubbles: true }));
  }, clave, texto);
}
const llamadas = () => page.evaluate(() => window.__llamadas);
const conUrl = async (url, metodo) => (await llamadas()).filter(l => l.url === url && (!metodo || l.metodo === metodo));
const clic = (sel) => page.evaluate((sel) => document.querySelector(sel).click(), sel);
const esperar = () => page.evaluate(() => new Promise(r => setTimeout(r, 30)));
async function revisarListo() {
  await clic('[data-acc="revisar"]'); await esperar();
}

await t('F1 numerada: el {{1}} del cuerpo arranca como nombre; el encabezado y el {{2}} como «Texto fijo» con su caja', async () => {
  await abrir();
  await nuevaCampana('0');
  const enc = await ranura('encabezado:1'); const nom = await ranura('cuerpo:1'); const promo = await ranura('cuerpo:2');
  assert(enc.fuente === 'fijo' && enc.cajaVisible && !enc.aviso, `encabezado: ${JSON.stringify(enc)}`);
  assert(nom.fuente === 'nombre' && !nom.cajaVisible && nom.aviso, `nombre: ${JSON.stringify(nom)}`);
  assert(promo.fuente === 'fijo' && promo.cajaVisible && !promo.aviso, `promo: ${JSON.stringify(promo)}`);
  const respaldo = await page.$eval('#cwa-respaldo', el => [el.value, el.closest('#cwa-respaldo-campo').style.display]);
  assert(respaldo[0] === 'buen día' && respaldo[1] === '', `respaldo: ${respaldo}`);
});

await t('F2 sin hueco de nombre: todas «Texto fijo», y el respaldo no se ve; cambiar a nombre lo muestra', async () => {
  await abrir();
  await nuevaCampana('1');
  for (const c of ['cuerpo:promo', 'cuerpo:sucursal']) {
    const r = await ranura(c);
    assert(r.fuente === 'fijo' && r.cajaVisible && !r.aviso, `${c}: ${JSON.stringify(r)}`);
  }
  assert(await page.$eval('#cwa-respaldo-campo', el => el.style.display === 'none'), 'el respaldo se ve sin usar el nombre');
  await page.select('[data-ranura="cuerpo:sucursal"] [data-fuente]', 'nombre');
  const r = await ranura('cuerpo:sucursal');
  assert(r.fuente === 'nombre' && !r.cajaVisible, `tras elegir nombre: ${JSON.stringify(r)}`);
  assert(await page.$eval('#cwa-respaldo-campo', el => el.style.display === ''), 'el respaldo no apareció');
});

await t('F3 sin «respaldoNombre» del servidor, el panel también propone «buen día»', async () => {
  await abrir({ metaPlantillas: meta({ respaldo: false }) });
  await nuevaCampana('0');
  assert(await page.$eval('#cwa-respaldo', el => el.value) === 'buen día', 'respaldo distinto de «buen día»');
});

await t('F4 vacío o con tabulador: aviso junto al campo, foco ahí y nada sale al servidor', async () => {
  await abrir();
  await nuevaCampana('0');
  await revisarListo();
  const enc = await ranura('encabezado:1'); const promo = await ranura('cuerpo:2');
  assert(/no puede ir vacío/.test(enc.error) && /no puede ir vacío/.test(promo.error), `avisos: ${enc.error} | ${promo.error}`);
  assert((await ranura('cuerpo:1')).error === '', 'el hueco del nombre no lleva aviso');
  assert(await page.evaluate(() => document.activeElement === document.querySelector('[data-ranura="encabezado:1"] [data-texto]')), 'el foco no quedó en el primero');
  assert(/Revisa los campos marcados/.test(await page.$eval('#cwa-estado', el => el.textContent)), 'sin mensaje general');
  await escribir('encabezado:1', 'Xabor');
  assert((await ranura('encabezado:1')).error === '', 'escribir no quitó el aviso');
  await escribir('cuerpo:2', '2x1\ten chilaquiles');
  await revisarListo();
  assert(/saltos de línea/.test((await ranura('cuerpo:2')).error), 'el tabulador pasó');
  await clic('[data-acc="prueba"]'); await esperar();
  assert(!(await conUrl('/api/admin/campanas-wa/vista-previa')).length, 'revisar llamó al servidor con un campo malo');
  assert(!(await conUrl('/api/admin/campanas-wa/prueba')).length, 'la prueba llamó al servidor con un campo malo');
});

await t('F5 bien llenado: la vista previa recibe fijo/nombre/fijo y «buen día»; sin bandera no hay «¿Cuándo?» y se manda sin fecha', async () => {
  await abrir();
  await nuevaCampana('0');
  assert(await page.$eval('#cwa-programar', el => el.innerHTML.trim() === ''), 'sin la bandera apareció programar');
  await page.type('#cwa-nombre', 'Jueves');
  await escribir('encabezado:1', 'Xabor'); await escribir('cuerpo:2', '2x1 en chilaquiles');
  await revisarListo();
  const [vp] = await conUrl('/api/admin/campanas-wa/vista-previa');
  assert(vp, 'no se pidió la vista previa');
  const v = vp.cuerpo.variables;
  assert(v['encabezado:1'].fuente === 'fijo' && v['encabezado:1'].texto === 'Xabor', `encabezado: ${JSON.stringify(v)}`);
  assert(v['cuerpo:1'].fuente === 'nombre' && v['cuerpo:2'].texto === '2x1 en chilaquiles', `cuerpo: ${JSON.stringify(v)}`);
  assert(vp.cuerpo.respaldoNombre === 'buen día', `respaldo: ${vp.cuerpo.respaldoNombre}`);
  assert(await page.$eval('#cwa-mandar', el => el.textContent) === 'Mandar a 3 clientes', 'texto del botón');
  await clic('#cwa-mandar'); await esperar();
  const [crear] = await conUrl('/api/admin/campanas-wa', 'POST');
  assert(crear && crear.cuerpo.programadaPara === '' && crear.cuerpo.totalVisto === 3, `crear: ${JSON.stringify(crear?.cuerpo)}`);
  const [pregunta] = await page.evaluate(() => window.__confirmaciones);
  assert(/^¿Mandar «Jueves» a 3 clientes\?/.test(pregunta), `confirmación: ${pregunta}`);
});

await t('F6 el campo de los envíos fallidos dice «Pausar si fallan más del (%) de los envíos»', async () => {
  await abrir();
  const etiqueta = await page.$eval('label[for="cwa-umbral"]', el => el.textContent.trim());
  assert(etiqueta === 'Pausar si fallan más del (%) de los envíos', `etiqueta: ${etiqueta}`);
  assert(!/no llegan más del/.test(await page.content()), 'queda el texto viejo');
});

await t('F7 con la bandera: programar pide fecha válida, no invalida lo revisado y manda la fecha local', async () => {
  await abrir({ metaPlantillas: meta({ programar: true }) });
  await nuevaCampana('0');
  const limites = await page.$eval('#cwa-cuando', el => [el.min, el.max]);
  assert(limites[0] === AHORA_LOCAL && limites[1] === '2026-12-23T09:40', `min/max: ${limites}`);
  assert(await page.$eval('#cwa-cuando-campo', el => el.style.display === 'none'), 'el calendario se ve en «Mandar ahora»');
  await page.type('#cwa-nombre', 'Jueves');
  await escribir('encabezado:1', 'Xabor'); await escribir('cuerpo:2', '2x1');
  await revisarListo();
  await clic('input[name="cwa-modo"][value="programar"]');
  assert(await page.$eval('#cwa-cuando-campo', el => el.style.display === ''), 'el calendario no apareció');
  assert(await page.$eval('#cwa-mandar', el => [el.disabled, el.textContent].join('|')) === 'false|Programar para 3 clientes', 'cambiar el modo invalidó lo revisado');
  await clic('#cwa-mandar'); await esperar();
  assert(/Elige la fecha y la hora/.test(await page.$eval('#cwa-cuando-error', el => el.textContent)), 'sin fecha no avisó');
  await page.$eval('#cwa-cuando', el => { el.value = '2026-11-24T08:30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await clic('#cwa-mandar'); await esperar();
  assert(/entre 9:00 y 20:59/.test(await page.$eval('#cwa-cuando-error', el => el.textContent)), 'las 8:30 pasaron');
  assert(!(await conUrl('/api/admin/campanas-wa', 'POST')).length, 'se mandó con una fecha mala');
  assert(!(await page.evaluate(() => window.__confirmaciones)).length, 'preguntó con una fecha mala');
  await page.$eval('#cwa-cuando', el => { el.value = '2026-11-25T10:00'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  assert(await page.$eval('#cwa-mandar', el => !el.disabled), 'cambiar la fecha invalidó lo revisado');
  await clic('#cwa-mandar'); await esperar();
  const [crear] = await conUrl('/api/admin/campanas-wa', 'POST');
  assert(crear && crear.cuerpo.programadaPara === '2026-11-25T10:00', `crear: ${JSON.stringify(crear?.cuerpo)}`);
  const [pregunta] = await page.evaluate(() => window.__confirmaciones);
  assert(/^¿Programar «Jueves» para el 25 nov, 10:00 \(hora del negocio\) a 3 clientes\?/.test(pregunta), `confirmación: ${pregunta}`);
  assert(/más de 6 h, se cancela sola/.test(pregunta), 'la confirmación no dice la tolerancia');
});

await t('F8 volver a «Mandar ahora» esconde el calendario y manda sin fecha', async () => {
  await abrir({ metaPlantillas: meta({ programar: true }) });
  await nuevaCampana('0');
  await page.type('#cwa-nombre', 'Jueves');
  await escribir('encabezado:1', 'Xabor'); await escribir('cuerpo:2', '2x1');
  await revisarListo();
  await clic('input[name="cwa-modo"][value="programar"]');
  await page.$eval('#cwa-cuando', el => { el.value = '2026-11-25T10:00'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await clic('input[name="cwa-modo"][value="ahora"]');
  assert(await page.$eval('#cwa-cuando-campo', el => el.style.display === 'none'), 'el calendario sigue a la vista');
  assert(await page.$eval('#cwa-mandar', el => el.textContent) === 'Mandar a 3 clientes', 'texto del botón');
  await clic('#cwa-mandar'); await esperar();
  const [crear] = await conUrl('/api/admin/campanas-wa', 'POST');
  assert(crear && crear.cuerpo.programadaPara === '', `crear: ${JSON.stringify(crear?.cuerpo)}`);
});

await t('F9 historial: la programada dice cuándo y se cancela con su propia pregunta; la que se manda, «fallan más del 10%»', async () => {
  const base = { tipo: 'plantilla', nombre: 'Jueves', plantilla: 'promo_jueves', creada: '2026-11-23T15:00:00Z', total: 3, enCola: 3,
    enviados: 0, entregados: 0, tope24h: 250, umbralRechazoPct: 10 };
  await abrir({ campanas: [
    { ...base, id: 7, estado: 'programada', programadaPara: '2026-11-25T16:00:00Z', programadaTexto: 'miércoles 25 nov, 10:00' },
    { ...base, id: 6, estado: 'enviando', enviados: 1 },
  ] });
  const programada = await page.$eval('[data-campana="7"]', el => el.innerText);
  assert(/Programada/.test(programada) && /Programada para el miércoles 25 nov, 10:00 \(hora del negocio\)/.test(programada), programada);
  assert(!(await page.$('[data-campana="7"] [data-acc="pausar"]')) && !(await page.$('[data-campana="7"] [data-acc="detener"]')), 'la programada trae Pausar/Detener');
  assert(/se pausa sola si fallan más del 10% de los envíos/.test(await page.$eval('[data-campana="6"]', el => el.innerText)), 'texto de la tanda');
  await clic('[data-campana="7"] [data-acc="cancelar-programada"]'); await esperar();
  const [pregunta] = await page.evaluate(() => window.__confirmaciones);
  assert(pregunta === '¿Cancelar la campaña programada? No le llega a nadie.', `confirmación: ${pregunta}`);
  assert((await conUrl('/api/admin/campanas-wa/7/detener', 'POST')).length === 1, 'no pidió cancelar la 7');
});

await t('Z1 sin errores de JavaScript en la página', async () => {
  assert(!erroresPagina.length, erroresPagina.join(' | '));
});

await navegador.close();
server.close();
console.log(`\nCampañas WA (panel): ${pasadas} pasadas, ${fallidas} fallidas.`);
process.exit(fallidas ? 1 : 0);
