// Pruebas de concurrencia y errores con respuestas controladas, sin navegador.
// La verificación visual se hace aparte contra la aplicación HTTP real.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const fuente = readFileSync(new URL('../public/superadmin-experiencia.js', import.meta.url), 'utf8').replace(/verificarAcceso\(\);\s*$/, '');
const inline = readFileSync(new URL('../panel/superadmin.html', import.meta.url), 'utf8');

function entorno(api) {
  const elementos = new Map();
  const el = id => {
    if (!elementos.has(id)) elementos.set(id, { value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, classList: { add() {}, remove() {}, toggle() {} }, setAttribute(k, v) { this[k] = v; } });
    return elementos.get(id);
  };
  const ctx = vm.createContext({ URLSearchParams, setTimeout, clearTimeout, api,
    document: { getElementById: el, querySelectorAll: () => [] },
    escaparHTML: texto => String(texto ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
    badgeEstado: s => s, fechaCorta: s => s,
  });
  vm.runInContext('let CE_OFFSET=0; const CE_LIMIT=25; let FICHA_NEGOCIO_ID=null;', ctx);
  vm.runInContext(fuente, ctx);
  return { ctx, el };
}
const resultado = nombre => ({ ok: true, json: async () => ({ total: 1, negocios: [{ id: 'qa-id', nombre, slug: 'qa', estado: 'activo', plan: 'prueba', num_pedidos: 0, num_productos: 0 }] }) });

test('una respuesta vieja no sustituye los resultados de una búsqueda nueva', async () => {
  const pendientes = [];
  const { ctx, el } = entorno(() => new Promise(resolve => pendientes.push(resolve)));
  const primera = ctx.cargarCentral();
  el('ce-buscar').value = 'nuevo';
  const segunda = ctx.cargarCentral();
  pendientes[1](resultado('Nuevo negocio')); await segunda;
  pendientes[0](resultado('Resultado anterior')); await primera;
  assert.match(el('ce-tabla').innerHTML, /Nuevo negocio/);
  assert.doesNotMatch(el('ce-tabla').innerHTML, /Resultado anterior/);
});

test('un error oculta resultados anteriores y ofrece reintentar sin accionar sobre datos viejos', async () => {
  const { ctx, el } = entorno(async () => ({ ok: false }));
  el('ce-tabla').innerHTML = 'Datos anteriores';
  await ctx.cargarCentral();
  assert.match(el('ce-tabla').innerHTML, /Reintentar/);
  assert.doesNotMatch(el('ce-tabla').innerHTML, /Datos anteriores/);
  assert.equal(el('ce-prev').disabled, true);
  assert.equal(el('ce-next').disabled, true);
});

test('nombres y notas se escapan en las tablas', async () => {
  const { ctx, el } = entorno(async () => resultado('<img src=x onerror=alert(1)>'));
  await ctx.cargarCentral();
  assert.doesNotMatch(el('ce-tabla').innerHTML, /<img/);
  assert.match(el('ce-tabla').innerHTML, /&lt;img/);
});

test('al fallar una ficha se ocultan los formularios y acciones de la cuenta anterior', async () => {
  const { ctx, el } = entorno(async () => ({ ok: false }));
  el('fi-contenido').hidden = false;
  await ctx.abrirFicha('otro-id');
  assert.equal(el('fi-contenido').hidden, true);
  assert.match(el('fi-error').innerHTML, /acciones permanecen ocultas/);
});

test('el documento conserva segundo factor, una entrada Negocios y todos los scripts tienen sintaxis válida', () => {
  assert.equal((inline.match(/class="tab" data-tab="central"/g) || []).length, 1);
  assert(!inline.includes('id="vista-negocios"'));
  assert(inline.includes('id="segundo-factor"'));
  for (const script of inline.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  new vm.Script(fuente);
});
