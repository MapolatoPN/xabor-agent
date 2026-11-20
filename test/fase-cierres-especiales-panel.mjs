// ─── DÍAS CERRADOS (FESTIVOS) EN EL PANEL ───────────────────────────────────
//
// Pedido de Mario (20-nov-2026): el lunes 16 Acuña cerró por festivo y
// mantenimiento. Sin pantalla para decirlo, desmarcaron el lunes en el horario
// de la semana: el domingo el bot dijo «abrimos mañana a las 7:30» y al volver
// a marcar el lunes quedó en 9:00–20:00. Ahora Configuración → Horarios trae
// «Días cerrados (festivos)» (panel/cierres-especiales.js) que guarda en
// reglas_atencion.cierres_especiales, y al reabrir un día propone el horario
// de los demás.
//
// Lo que cuida:
//   P. lo puro del módulo (vm): normalizar, horarioSugerido, fechaLegible.
//   C. lo que guarda el panel lo acepta el servidor y lo entienden el bot, la
//      tienda y el descuento tras cierre (horarioSemanal), con el caso real.
//   V. la revisión del servidor (src/services/cierresEspeciales.js), y que la
//      validación que usa el bot al LEER no se endureció.
//   D. la pantalla (Puppeteer, sin servidor).
//   S. el cableado en index.html y server.js.
//   R. la ruta real PUT /api/config (servidor + base test_botones_*).
//      SIN_BASE=1 la omite.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import puppeteer from 'puppeteer';
import { validarCierresEspeciales } from '../src/services/cierresEspeciales.js';
import { evaluarHorarioLocal } from '../src/services/horarioSemanal.js';
import { siguienteApertura } from '../src/mesero-agente/horarioDelAgente.js';
import { llegoCerradoEnHorarioHabitual } from '../src/services/descuentoTrasCierrePolitica.js';
import { validarEstructuraReglas } from '../src/agent/prompts.js';

const leer = (r) => readFileSync(new URL(`../${r}`, import.meta.url));
const FUENTE = leer('panel/cierres-especiales.js');
const PANEL = leer('panel/index.html').toString('utf8');
const SERVER = leer('src/server.js').toString('utf8');

let pasadas = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function t(id, nombre, fn) {
  if (SOLO.length && !SOLO.includes(id)) return;
  try { await fn(); pasadas++; console.log(`ok    ${id} ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA ${id} ${nombre}\n      ${String(e?.message || e).split('\n').join('\n      ')}`); }
}

// El módulo en una caja aparte, como lo carga el navegador.
const ctx = { console };
vm.createContext(ctx);
new vm.Script(FUENTE.toString('utf8'), { filename: 'cierres-especiales.js' }).runInContext(ctx);
const M = ctx.XaborCierresEspeciales;
const plano = (x) => JSON.parse(JSON.stringify(x));

// Acuña tal como estaba antes del festivo: lunes a sábado 7:30–14:00, domingo cerrado.
const HORARIOS_ACUNA = {
  lunes: { abierto: true, apertura: '07:30', cierre: '14:00' }, martes: { abierto: true, apertura: '07:30', cierre: '14:00' },
  miercoles: { abierto: true, apertura: '07:30', cierre: '14:00' }, jueves: { abierto: true, apertura: '07:30', cierre: '14:00' },
  viernes: { abierto: true, apertura: '07:30', cierre: '14:00' }, sabado: { abierto: true, apertura: '07:30', cierre: '14:00' },
  domingo: { abierto: false, apertura: null, cierre: null },
};
const reglasCon = (cierres, horarios = HORARIOS_ACUNA) => ({
  restaurante: 'Prueba', timezone: 'America/Matamoros', horarios,
  pedidos: { costo_envio: 0, pedido_minimo_entrega: 0, modalidades: ['recoger en tienda'] },
  cierres_especiales: cierres, promociones: [], politicas: [],
});

// ══ P) Lo puro ════════════════════════════════════════════════════════════════
await t('P1', 'cerrado todo el día se guarda sin hora; temprano con su hora; ordenados por fecha', () => {
  const r = M.normalizar([
    { fecha: '2026-12-24', motivo: 'Nochebuena', modo: 'temprano', hora_cierre: '12:00' },
    { fecha: '2026-11-16', motivo: 'Día festivo', modo: 'todo', hora_cierre: '11:00' },
  ], { hoy: '2026-11-20' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(plano(r.lista), [
    { fecha: '2026-11-16', motivo: 'Día festivo' },
    { fecha: '2026-12-24', motivo: 'Nochebuena', hora_cierre: '12:00' },
  ]);
});
await t('P2', 'sin fecha no se guarda y dice qué renglón', () => {
  const r = M.normalizar([{ fecha: '2026-11-16', motivo: 'x' }, { fecha: '', motivo: '' }], { hoy: '2026-11-20' });
  assert.equal(r.ok, false); assert.equal(r.fila, 1); assert.match(r.error, /falta la fecha/);
});
await t('P3', 'una fecha que no existe no se guarda', () => {
  const r = M.normalizar([{ fecha: '2026-02-30' }], { hoy: '2026-01-01' });
  assert.equal(r.ok, false); assert.match(r.error, /no es válida/);
});
await t('P4', 'el mismo día dos veces no se guarda', () => {
  const r = M.normalizar([{ fecha: '2026-12-25' }, { fecha: '2026-12-25', modo: 'temprano', hora_cierre: '13:00' }], { hoy: '2026-11-20' });
  assert.equal(r.ok, false); assert.equal(r.fila, 1); assert.match(r.error, /viernes 25 de diciembre de 2026 está dos veces/);
});
await t('P5', '«cierra temprano» exige una hora válida y no acepta 00:00', () => {
  for (const hora of ['', '25:00', 'mediodía']) {
    const r = M.normalizar([{ fecha: '2026-12-24', modo: 'temprano', hora_cierre: hora }], { hoy: '2026-11-20' });
    assert.equal(r.ok, false, `aceptó «${hora}»`); assert.match(r.error, /a qué hora cierran/);
  }
  const cero = M.normalizar([{ fecha: '2026-12-24', modo: 'temprano', hora_cierre: '00:00' }], { hoy: '2026-11-20' });
  assert.equal(cero.ok, false); assert.match(cero.error, /Cerrado todo el día/);
});
await t('P6', 'sin motivo se guarda «cierre especial»; un motivo de más de 80 letras no', () => {
  const r = M.normalizar([{ fecha: '2026-12-25', motivo: '   ' }], { hoy: '2026-11-20' });
  assert.equal(r.ok, true); assert.equal(r.lista[0].motivo, 'cierre especial');
  const largo = M.normalizar([{ fecha: '2026-12-25', motivo: 'x'.repeat(81) }], { hoy: '2026-11-20' });
  assert.equal(largo.ok, false); assert.match(largo.error, /muy largo/);
});
await t('P7', 'los días que pasaron hace más de 30 se quitan; los recientes se quedan', () => {
  const r = M.normalizar([{ fecha: '2026-10-20' }, { fecha: '2026-10-21' }, { fecha: '2026-11-16' }], { hoy: '2026-11-20' });
  assert.equal(r.ok, true);
  assert.deepEqual(plano(r.lista).map((e) => e.fecha), ['2026-10-21', '2026-11-16']);
});
await t('P8', 'conserva lo que otro lado haya escrito en el día y quita la hora al pasar a «todo el día»', () => {
  const original = { fecha: '2026-12-24', motivo: 'Nochebuena', hora_cierre: '12:00', aviso: 'cartel' };
  const r = M.normalizar([{ fecha: '2026-12-24', motivo: 'Nochebuena', modo: 'todo', hora_cierre: '12:00', original }], { hoy: '2026-11-20' });
  assert.equal(r.ok, true);
  assert.deepEqual(plano(r.lista[0]), { fecha: '2026-12-24', motivo: 'Nochebuena', aviso: 'cartel' });
});
await t('P9', 'al reabrir un día se propone el horario más común de los demás, no 9:00–20:00', () => {
  const acunaSinLunes = { ...HORARIOS_ACUNA, lunes: { abierto: false, apertura: null, cierre: null } };
  assert.deepEqual(plano(M.horarioSugerido(acunaSinLunes)), { apertura: '07:30', cierre: '14:00' });
  // Así quedó Acuña el 20-nov: el lunes en 9–20 no le gana a cinco días en 7:30–14.
  const acunaHoy = { ...HORARIOS_ACUNA, lunes: { abierto: true, apertura: '09:00', cierre: '20:00' } };
  assert.deepEqual(plano(M.horarioSugerido(acunaHoy)), { apertura: '07:30', cierre: '14:00' });
  assert.deepEqual(plano(M.horarioSugerido({})), { apertura: '09:00', cierre: '20:00' });
  const empate = { lunes: { abierto: true, apertura: '08:00', cierre: '15:00' }, martes: { abierto: true, apertura: '10:00', cierre: '18:00' } };
  assert.deepEqual(plano(M.horarioSugerido(empate)), { apertura: '08:00', cierre: '15:00' });
});
await t('P10', 'la fecha se lee en español', () => {
  assert.equal(M.fechaLegible('2026-11-16'), 'lunes 16 de noviembre de 2026');
  assert.equal(M.fechaLegible('2027-01-01'), 'viernes 1 de enero de 2027');
});
await t('P11', 'un día NUEVO con fecha pasada no se quita callado: avisa que revise la fecha', () => {
  for (const fecha of ['2025-11-16', '2026-11-19', '0002-12-24']) {
    const r = M.normalizar([{ fecha, modo: 'todo', original: {} }], { hoy: '2026-11-20' });
    assert.equal(r.ok, false, `aceptó ${fecha}`); assert.match(r.error, /ya pasó: revisa la fecha/);
  }
  // Cambiarle la fecha a uno guardado cuenta como nuevo.
  const cambiado = M.normalizar([{ fecha: '2025-12-25', original: { fecha: '2026-12-25', motivo: 'Navidad' } }], { hoy: '2026-11-20' });
  assert.equal(cambiado.ok, false); assert.match(cambiado.error, /ya pasó/);
  // Hoy sí se puede.
  assert.equal(M.normalizar([{ fecha: '2026-11-20', original: {} }], { hoy: '2026-11-20' }).ok, true);
  // Uno ya guardado y viejo se quita sin error (P7).
  assert.deepEqual(plano(M.normalizar([{ fecha: '2026-09-01', original: { fecha: '2026-09-01' } }], { hoy: '2026-11-20' })), { ok: true, lista: [] });
});
await t('P12', 'un día NUEVO a más de dos años es un error de dedo en el año', () => {
  const r = M.normalizar([{ fecha: '2028-12-24', original: {} }], { hoy: '2026-11-20' });
  assert.equal(r.ok, false); assert.match(r.error, /más de dos años: revisa el año/);
  assert.equal(M.normalizar([{ fecha: '2028-11-19', original: {} }], { hoy: '2026-11-20' }).ok, true);
});

// ══ C) Lo que guarda el panel lo entienden el servidor, el bot y el descuento ══
const DEL_PANEL = M.normalizar([{ fecha: '2026-11-16', motivo: 'Día festivo', modo: 'todo' }], { hoy: '2026-11-14' });
await t('C1', 'el servidor acepta exactamente lo que guarda el panel', () => {
  assert.equal(DEL_PANEL.ok, true);
  assert.deepEqual(validarCierresEspeciales(plano(DEL_PANEL.lista)), { ok: true });
  const temprano = M.normalizar([{ fecha: '2026-12-24', modo: 'temprano', hora_cierre: '12:00' }], { hoy: '2026-11-20' });
  assert.deepEqual(validarCierresEspeciales(plano(temprano.lista)), { ok: true });
});
await t('C2', 'con el lunes 16 marcado, ese día no se abre aunque el horario de la semana diga que sí', () => {
  const reglas = reglasCon(plano(DEL_PANEL.lista));
  assert.equal(evaluarHorarioLocal(reglas, '2026-11-16', 9 * 60).abierto, false);
  assert.equal(evaluarHorarioLocal(reglas, '2026-11-17', 9 * 60).abierto, true);
  assert.equal(evaluarHorarioLocal(reglasCon([]), '2026-11-16', 9 * 60).abierto, true);
});
await t('C3', 'el domingo 15 el bot dice que abren el martes 17 a las 7:30, no «mañana»', () => {
  const domingo = { diaActual: 'domingo', fechaHoy: '2026-11-15', preApertura: false, cierreEspecial: null };
  const con = siguienteApertura(reglasCon(plano(DEL_PANEL.lista)), domingo);
  assert.deepEqual({ dia: con.dia, fecha: con.fecha, apertura: con.apertura }, { dia: 'martes', fecha: '2026-11-17', apertura: '07:30' });
  assert.equal(siguienteApertura(reglasCon([]), domingo).dia, 'lunes', 'sin el festivo debería decir lunes');
});
await t('C4', 'quien escribe el lunes festivo en horario habitual cuenta como «escribió con el negocio cerrado»', () => {
  assert.equal(llegoCerradoEnHorarioHabitual(reglasCon(plano(DEL_PANEL.lista)), '2026-11-16', 8 * 60), true);
  assert.equal(llegoCerradoEnHorarioHabitual(reglasCon([]), '2026-11-16', 8 * 60), false);
});
await t('C5', 'cierre temprano: abre a su hora y cierra a la del festivo', () => {
  const temprano = M.normalizar([{ fecha: '2026-12-24', motivo: 'Nochebuena', modo: 'temprano', hora_cierre: '12:00' }], { hoy: '2026-11-20' });
  const reglas = reglasCon(plano(temprano.lista));
  assert.equal(evaluarHorarioLocal(reglas, '2026-12-24', 11 * 60).abierto, true);
  assert.equal(evaluarHorarioLocal(reglas, '2026-12-24', 12 * 60 + 30).abierto, false);
});

// ══ V) La revisión del servidor ═══════════════════════════════════════════════
await t('V1', 'acepta lista vacía, todo el día, temprano y hora vacía o nula', () => {
  for (const lista of [[], [{ fecha: '2026-11-16' }], [{ fecha: '2026-11-16', motivo: 'x', hora_cierre: '13:30' }],
    [{ fecha: '2026-11-16', hora_cierre: '' }], [{ fecha: '2026-11-16', hora_cierre: null, motivo: null }]]) {
    assert.deepEqual(validarCierresEspeciales(lista), { ok: true }, JSON.stringify(lista));
  }
});
await t('V2', 'rechaza lo que el bot no entendería', () => {
  const malos = [
    [null, /lista/], [{}, /lista/], [[null], /formato/], [['2026-11-16'], /formato/],
    [[{ fecha: '16/11/2026' }], /no es válida/], [[{ fecha: '2026-11-31' }], /no es válida/], [[{}], /no es válida/],
    [[{ fecha: '2026-11-16' }, { fecha: '2026-11-16' }], /dos veces/],
    [[{ fecha: '2026-11-16', hora_cierre: '25:00' }], /hora de cierre/], [[{ fecha: '2026-11-16', hora_cierre: '00:00' }], /hora de cierre/],
    [[{ fecha: '2026-11-16', hora_cierre: 1300 }], /hora de cierre/],
    [[{ fecha: '2026-11-16', motivo: 7 }], /motivo/], [[{ fecha: '2026-11-16', motivo: 'x'.repeat(81) }], /motivo/],
    [Array.from({ length: 61 }, (_, i) => ({ fecha: `2027-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` })), /demasiados/],
  ];
  for (const [lista, error] of malos) {
    const r = validarCierresEspeciales(lista);
    assert.equal(r.ok, false, `aceptó ${JSON.stringify(lista).slice(0, 80)}`);
    assert.match(r.error, error);
  }
});
await t('V3', 'la validación que usa el bot al LEER sigue aceptando un día mal escrito (no cae a los horarios por omisión)', () => {
  assert.equal(validarEstructuraReglas(reglasCon([{ fecha: '16/11/2026' }])), true);
});

// ══ S) El cableado ════════════════════════════════════════════════════════════
await t('S1', 'index.html carga cierres-especiales.js con la huella de su contenido', () => {
  const huella = createHash('sha256').update(FUENTE).digest('hex').slice(0, 8);
  const m = PANEL.match(/<script src="\/cierres-especiales\.js\?v=([0-9a-f]+)"><\/script>/);
  assert.ok(m, 'index.html no carga /cierres-especiales.js');
  assert.equal(m[1], huella, `el ?v= dice "${m[1]}" y el archivo tiene huella "${huella}": pon "${huella}" en index.html`);
});
await t('S2', 'el formulario de horarios propone el horario sugerido y pinta la lista', () => {
  const ini = PANEL.indexOf('function renderReglasForm(');
  const fin = PANEL.indexOf('\nfunction renderZonasEntrega(', ini);
  const f = PANEL.slice(ini, fin);
  assert.ok(ini > 0 && fin > ini, 'no encontré renderReglasForm');
  assert.match(f, /const sug = window\.XaborCierresEspeciales\?\.horarioSugerido\(reglas\.horarios\)/);
  assert.match(f, /value="\$\{h\.apertura\|\|sug\.apertura\}"/);
  assert.match(f, /value="\$\{h\.cierre\|\|sug\.cierre\}"/);
  assert.doesNotMatch(f, /h\.apertura\|\|'09:00'|h\.cierre\|\|'20:00'/, 'sigue el 9:00–20:00 fijo');
  assert.match(f, /<div id="reg-cierres-especiales"><\/div>/);
  assert.match(f, /window\.XaborCierresEspeciales\?\.pintar\(document\.getElementById\('reg-cierres-especiales'\), reglas\.cierres_especiales \|\| \[\]\);/);
});
await t('S3', 'guardarReglas guarda lo de la lista y no guarda nada si algo está mal', () => {
  const ini = PANEL.indexOf('async function guardarReglas(');
  const f = PANEL.slice(ini, PANEL.indexOf('\n}\n', ini));
  assert.match(f, /const cierres = window\.XaborCierresEspeciales\?\.leer\(\) \|\| null;/);
  const corte = f.indexOf('if (cierres && !cierres.ok) {');
  const bloque = corte > 0 ? f.slice(corte, f.indexOf('\n  }\n', corte)) : '';
  assert.ok(/\breturn;/.test(bloque), 'con un error en la lista todavía llega al PUT');
  assert.ok(corte < f.indexOf("apiFetch('/api/config'"), 'revisa la lista después de mandar');
  assert.match(f, /cierres_especiales: cierres \? cierres\.lista : \(reglasActuales\.cierres_especiales \|\| \[\]\),/);
  assert.equal((PANEL.match(/function guardarReglas\(/g) || []).length, 1, 'guardarReglas está dos veces');
  assert.equal((PANEL.match(/function renderReglasForm\(/g) || []).length, 1, 'renderReglasForm está dos veces');
});
await t('S4', 'PUT /api/config revisa los días cerrados después de la estructura', () => {
  const ini = SERVER.indexOf("app.put('/api/config'");
  const f = SERVER.slice(ini, SERVER.indexOf('\n});', ini));
  const estructura = f.indexOf('validarEstructuraReglas(reglas)');
  const cierres = f.indexOf('const cierres = validarCierresEspeciales(reglas.cierres_especiales);');
  assert.ok(estructura > 0 && cierres > estructura, 'no revisa los días cerrados');
  assert.ok(f.indexOf('if (!cierres.ok) return res.status(400).json({ error: cierres.error });') > cierres);
  assert.ok(f.indexOf('cambios.reglas_atencion = JSON.stringify(reglas);') > cierres, 'guarda antes de revisar');
  assert.match(SERVER, /^import \{ validarCierresEspeciales \} from '\.\/services\/cierresEspeciales\.js';$/m);
});

// ══ D) La pantalla ════════════════════════════════════════════════════════════
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const nueva = async (lista) => {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><body><div id="c"></div></body>');
    await page.addScriptTag({ content: FUENTE.toString('utf8') });
    await page.evaluate((l) => window.XaborCierresEspeciales.pintar(document.getElementById('c'), l), lista);
    return page;
  };
  const poner = (page, sel, valor) => page.evaluate((s, v) => {
    const el = document.querySelector(s); el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }, sel, valor);
  const leerLista = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.XaborCierresEspeciales.leer())));

  await t('D1', 'pinta lo guardado ordenado, con la fecha en palabras y la hora solo si cierra temprano', async () => {
    const page = await nueva([
      { fecha: '2026-12-24', motivo: 'Nochebuena', hora_cierre: '12:00' },
      { fecha: '2026-11-16', motivo: 'Día festivo' },
    ]);
    const filas = await page.$$eval('[data-fila]', (fs) => fs.map((f) => ({
      fecha: f.querySelector('[data-campo="fecha"]').value,
      modo: f.querySelector('[data-campo="modo"]').value,
      hora: getComputedStyle(f.querySelector('[data-campo="hora_cierre"]')).display !== 'none',
      nota: f.querySelector('[data-nota]').textContent,
    })));
    assert.deepEqual(filas.map((f) => [f.fecha, f.modo, f.hora]), [['2026-11-16', 'todo', false], ['2026-12-24', 'temprano', true]]);
    assert.match(filas[0].nota, /^lunes 16 de noviembre de 2026 · no se abre/);
    assert.match(filas[1].nota, /^jueves 24 de diciembre de 2026 · se cierra temprano/);
    await page.close();
  });
  await t('D2', 'agregar un día sin fecha no deja guardar y marca el error en su renglón', async () => {
    const page = await nueva([]);
    await page.click('[data-accion="agregar"]');
    const r = await leerLista(page);
    assert.equal(r.ok, false); assert.match(r.error, /falta la fecha/);
    const err = await page.$eval('[data-fila="0"] [data-error]', (e) => e.textContent);
    assert.match(err, /falta la fecha/);
    await page.close();
  });
  // Un día nuevo debe caer entre hoy y dos años: el 31 de diciembre del año que entra.
  const FUTURO = `${new Date().getFullYear() + 1}-12-31`;
  await t('D3', 'llenar fecha, «cierra temprano» y hora deja el día listo para guardar', async () => {
    const page = await nueva([]);
    await page.click('[data-accion="agregar"]');
    await poner(page, '[data-fila="0"] [data-campo="fecha"]', FUTURO);
    assert.equal(await page.$eval('[data-fila="0"] [data-error]', (e) => e.textContent), '', 'el error no se limpió al escribir');
    await page.select('[data-fila="0"] [data-campo="modo"]', 'temprano');
    assert.notEqual(await page.$eval('[data-fila="0"] [data-campo="hora_cierre"]', (e) => getComputedStyle(e).display), 'none');
    await poner(page, '[data-fila="0"] [data-campo="hora_cierre"]', '15:00');
    await poner(page, '[data-fila="0"] [data-campo="motivo"]', 'Fin de año');
    assert.match(await page.$eval('[data-fila="0"] [data-nota]', (e) => e.textContent), /31 de diciembre de \d{4} · se cierra temprano$/);
    assert.deepEqual(await leerLista(page), { ok: true, lista: [{ fecha: FUTURO, motivo: 'Fin de año', hora_cierre: '15:00' }] });
    await page.select('[data-fila="0"] [data-campo="modo"]', 'todo');
    assert.deepEqual(await leerLista(page), { ok: true, lista: [{ fecha: FUTURO, motivo: 'Fin de año' }] });
    // Un error de dedo en el año (lo que deja el campo a medio escribir) avisa en su renglón.
    await poner(page, '[data-fila="0"] [data-campo="fecha"]', '0002-12-31');
    const r = await leerLista(page);
    assert.equal(r.ok, false); assert.match(r.error, /ya pasó: revisa la fecha/);
    assert.match(await page.$eval('[data-fila="0"] [data-error]', (e) => e.textContent), /ya pasó/);
    await page.close();
  });
  await t('D4', 'quitar borra ese día y solo ese', async () => {
    const page = await nueva([{ fecha: '2099-11-16', motivo: 'A' }, { fecha: '2099-12-25', motivo: 'B' }]);
    await page.click('[data-fila="0"] [data-accion="quitar"]');
    assert.deepEqual(await leerLista(page), { ok: true, lista: [{ fecha: '2099-12-25', motivo: 'B' }] });
    await page.close();
  });
  await t('D5', 'el motivo se muestra como texto: no mete HTML en el panel', async () => {
    const page = await nueva([{ fecha: '2026-11-16', motivo: '"><img src=x onerror="window.__xss=1">' }]);
    assert.equal(await page.$('#c img'), null, 'el motivo creó una imagen');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.$eval('[data-campo="motivo"]', (e) => e.value), '"><img src=x onerror="window.__xss=1">');
    await page.close();
  });
  await t('D6', 'fuera de pantalla leer() devuelve null (se conserva lo guardado)', async () => {
    const page = await nueva([{ fecha: '2026-11-16' }]);
    assert.equal(await page.evaluate(() => { document.getElementById('c').remove(); return window.XaborCierresEspeciales.leer(); }), null);
    await page.close();
  });
  await t('D7', 'guardarReglas (la de index.html): con un error no llama al servidor; sin error manda la lista', async () => {
    const ini = PANEL.indexOf('async function guardarReglas(');
    const fuente = PANEL.slice(ini, PANEL.indexOf('\n}\n', ini) + 2);
    const dias = PANEL.match(/^const DIAS_SEMANA = .*;$/m)?.[0];
    assert.ok(ini > 0 && dias, 'no encontré guardarReglas o DIAS_SEMANA');
    const campos = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map((d) => `<input type="checkbox" id="reg-dia-${d}" checked><input id="reg-apertura-${d}" value="07:30"><input id="reg-cierre-${d}" value="14:00">`).join('')
      + ['reg-tiempo-prep', 'reg-pedido-minimo', 'reg-costo-envio', 'reg-entrega-gratis', 'reg-entrega-min', 'reg-entrega-max', 'reg-notas', 'reg-pago-instrucciones']
        .map((id) => `<input id="${id}" value="0">`).join('')
      + '<textarea id="reg-politicas"></textarea><div id="reglas-feedback"></div><div id="reg-cierres-especiales"></div>';
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><meta charset="utf-8"><body>${campos}</body>`);
    await page.addScriptTag({ content: `${dias}
      var reglasActuales = { horarios: {}, pedidos: {}, cierres_especiales: [{ fecha: '2026-01-01', motivo: 'ya guardado' }], promociones: [], politicas: [] };
      var zonasEntregaTmp = [];
      window.__llamadas = [];
      async function apiFetch(url, op) { window.__llamadas.push({ url: url, cuerpo: JSON.parse(op.body) }); return { ok: true, json: async () => ({}) }; }
      window.XaborCierresEspeciales = { leer: function () { return window.__leer; }, pintar: function () {} };
      ${fuente}` });
    const guardar = (leer) => page.evaluate(async (l) => { window.__leer = l; await guardarReglas(); return {
      llamadas: window.__llamadas.length, ultima: window.__llamadas.at(-1)?.cuerpo?.reglas_atencion?.cierres_especiales,
      aviso: document.getElementById('reglas-feedback').textContent } }, leer);
    const conError = await guardar({ ok: false, fila: 0, error: 'A un día cerrado le falta la fecha: ponla o quita ese renglón.' });
    assert.equal(conError.llamadas, 0, 'con un error en la lista llamó al servidor');
    assert.match(conError.aviso, /falta la fecha/);
    const bien = await guardar({ ok: true, lista: [{ fecha: '2026-12-25', motivo: 'Navidad' }] });
    assert.equal(bien.llamadas, 1);
    assert.deepEqual(bien.ultima, [{ fecha: '2026-12-25', motivo: 'Navidad' }]);
    const fuera = await guardar(null);
    assert.equal(fuera.llamadas, 2);
    assert.deepEqual(fuera.ultima, [{ fecha: '2026-12-25', motivo: 'Navidad' }], 'fuera de pantalla no conservó lo guardado');
    await page.close();
  });
} finally {
  await browser.close();
}

// ══ R) La ruta real ═══════════════════════════════════════════════════════════
if (process.env.SIN_BASE === '1') {
  console.log('\n(SIN_BASE=1: se omite la parte R)');
} else {
  const { exigirBaseBotonesLocal } = await import('./lib-botones-local.mjs');
  exigirBaseBotonesLocal();
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const { crearTokenSesion } = await import('../src/services/session.js');
  const { pool } = await import('../src/services/database.js');
  const PUERTO = process.env.TEST_PORT_CIERRES || '4793';
  const base = `http://localhost:${PUERTO}`;
  const id = randomUUID(), marca = randomUUID().slice(0, 8);
  const sesiones = {};
  let servidor;
  const guardadas = async () => {
    const { rows: [f] } = await pool.query("SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'reglas_atencion'", [id]);
    return f ? JSON.parse(f.valor).cierres_especiales : null;
  };
  const put = async (cierres, cookie = sesiones.admin) => {
    const r = await fetch(`${base}/api/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ reglas_atencion: reglasCon(cierres) }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    await pool.query('INSERT INTO negocios (id, nombre, slug, activo) VALUES ($1,$2,$3,TRUE)', [id, `Cierres ${marca}`, `cierres-${marca}`]);
    for (const rol of ['admin', 'staff']) {
      const { rows: [u] } = await pool.query(
        'INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1,$2,$3,TRUE) RETURNING id',
        [id, `${rol} ${marca}`, `${rol}-${marca}@cierres.local`]);
      await pool.query('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,TRUE)', [u.id, id, rol]);
      sesiones[rol] = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u.id, negocioId: id, rol }))}`;
    }
    servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });

    await t('R1', 'el administrador guarda días cerrados y quedan guardados tal cual', async () => {
      const lista = [{ fecha: '2026-11-16', motivo: 'Día festivo' }, { fecha: '2026-12-24', motivo: 'Nochebuena', hora_cierre: '12:00' }];
      const r = await put(lista);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(await guardadas(), lista);
    });
    await t('R2', 'una fecha mal escrita, un día repetido o una hora imposible: 400 y no se toca lo guardado', async () => {
      const antes = await guardadas();
      for (const [lista, error] of [[[{ fecha: '16/11/2026' }], /no es válida/], [[{ fecha: '2026-11-16' }, { fecha: '2026-11-16' }], /dos veces/],
        [[{ fecha: '2026-11-16', hora_cierre: '25:00' }], /hora de cierre/]]) {
        const r = await put(lista);
        assert.equal(r.status, 400, JSON.stringify(lista));
        assert.match(r.body.error || '', error);
      }
      assert.deepEqual(await guardadas(), antes);
    });
    await t('R3', 'un operador (staff) no puede cambiar el horario', async () => {
      const r = await put([], sesiones.staff);
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal((await guardadas()).length, 2);
    });
  } finally {
    servidor?.detener();
    for (const sql of ['DELETE FROM configuracion WHERE negocio_id = $1', 'DELETE FROM usuario_negocios WHERE negocio_id = $1',
      'DELETE FROM usuarios WHERE negocio_id = $1', 'DELETE FROM negocios WHERE id = $1']) {
      await pool.query(sql, [id]).catch((e) => console.log(`limpieza: ${e.message}`));
    }
    await pool.end().catch(() => {});
  }
}

console.log(`\nDías cerrados en el panel: ${pasadas} pasadas, ${fallidas} fallidas. Sin red externa.`);
process.exit(fallidas ? 1 : 0);
