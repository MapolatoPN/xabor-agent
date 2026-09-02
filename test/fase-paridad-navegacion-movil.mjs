// Paridad de navegación móvil ↔ desktop.
//
// Existe porque el drawer "Más" del móvil era una lista de módulos escrita a
// mano, aparte del sidebar de escritorio. Las dos listas se desincronizaron:
// en el iPhone faltaban Tienda en línea/Promociones, Rewards, Asistente,
// Ajustes, Cotizaciones, Estado, Restaurante e Inicio — módulos que el negocio
// SÍ tenía habilitados y que en desktop sí aparecían.
//
// El arreglo hace del sidebar (#tabs-nav) la ÚNICA fuente de navegación: el
// drawer se genera desde él en construirDrawerMovil(), tomando solo los tabs
// que quedaron visibles tras los gates (admin-only + aplicarModulosUI) y que no
// viven ya en la barra inferior. Esta suite protege ese invariante ejecutando
// las FUNCIONES REALES del panel contra un DOM mínimo armado desde el MARKUP
// REAL de #tabs-nav. Si el drawer vuelve a tener lista propia, si deja de
// derivarse del sidebar, o si un módulo habilitado en desktop no llega a móvil,
// esto falla — cosa que una prueba de regex no detectaría.
//
// No hay jsdom en el proyecto (mismo motivo que fase-sidebar-plegable.mjs), así
// que se arma el DOM a mano. No toca red, ni base de datos, ni backend.
import { readFileSync } from 'fs';
import assert from 'assert';

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ─── Lectura del markup real del sidebar ─────────────────────────────────────
const navHtml = html.match(/<div id="tabs-nav">([\s\S]*?)\n<\/div>\n\n<main>/);
assert.ok(navHtml, 'no se encontró el bloque #tabs-nav en el panel');
const NAV = navHtml[1];

// Cada .tab-btn con sus atributos, sin depender del orden de los atributos.
function parseBotones(fragmento) {
  const out = [];
  for (const m of fragmento.matchAll(/<button\b([^>]*\bclass="tab-btn[^"]*"[^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (!id) continue;
    out.push({
      id,
      clases: (attrs.match(/\bclass="([^"]+)"/) || [, ''])[1].split(/\s+/).filter(Boolean),
      modulo: (attrs.match(/\bdata-modulo="([^"]+)"/) || [])[1] || null,
      moduloAny: (attrs.match(/\bdata-modulo-any="([^"]+)"/) || [])[1] || null,
      // Texto visible sin etiquetas anidadas (p. ej. el badge de Chats).
      label: m[2].replace(/<[^>]*>/g, '').replace(/&#x[0-9A-Fa-f]+;|&#\d+;/g, m => m).replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

const TODOS = parseBotones(NAV);
assert.ok(TODOS.length >= 15, `esperaba ≥15 tabs en el sidebar, hallé ${TODOS.length}`);

// Secciones (en orden) y sus tabs; más los tabs sueltos antes del primer grupo.
const SECCIONES = [];
for (const m of NAV.matchAll(/<div class="nav-seccion" id="navsec-([a-z]+)"[^>]*>([\s\S]*?)\n  <\/div>/g)) {
  SECCIONES.push({ clave: m[1], tabs: parseBotones(m[2]).map(b => b.id) });
}
const idsEnSecciones = new Set(SECCIONES.flatMap(s => s.tabs));
const SUELTOS = TODOS.filter(b => !idsEnSecciones.has(b.id)).map(b => b.id); // Inicio

// ─── Extracción de las funciones REALES ──────────────────────────────────────
function extraer(desde, hasta) {
  const i = html.indexOf(desde);
  const j = html.indexOf(hasta, i);
  assert.ok(i >= 0 && j > i, `no se pudo extraer el bloque que empieza en «${desde}»`);
  return html.slice(i, j);
}
const SRC_APLICAR = extraer('function aplicarModulosUI() {', '\nfunction primerTabVisible');
const SRC_DRAWER  = extraer('const NAV_ICONOS = {', '\nasync function cargarProgramados');

// ─── DOM mínimo sobre la estructura real ─────────────────────────────────────
function crearEl(tag) {
  const el = {
    tagName: tag, _hijos: [], _clases: new Set(), _attrs: {}, dataset: {},
    style: {}, _texto: '', _listeners: {}, _clicks: 0,
    classList: {
      add: c => el._clases.add(c), remove: c => el._clases.delete(c),
      contains: c => el._clases.has(c),
    },
    appendChild: (c) => { el._hijos.push(c); c._padre = el; return c; },
    addEventListener: (ev, fn) => { (el._listeners[ev] ||= []).push(fn); },
    click: () => { el._clicks++; (el._listeners.click || []).forEach(fn => fn()); },
    setAttribute: (k, v) => { el._attrs[k] = String(v); },
    getAttribute: (k) => (k in el._attrs ? el._attrs[k] : null),
    querySelectorAll: (sel) => selEn(el, sel),
  };
  Object.defineProperty(el, 'className', {
    get: () => [...el._clases].join(' '),
    set: (v) => { el._clases = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  Object.defineProperty(el, 'textContent', {
    get: () => (el._hijos.length ? el._hijos.map(h => h.textContent).join('') : el._texto),
    set: (v) => { el._texto = String(v); el._hijos = []; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => '', set: (v) => { if (v === '') { el._hijos = []; } },
  });
  return el;
}
function selEn(raiz, sel) {
  const todos = [];
  const rec = (n) => { for (const h of n._hijos) { todos.push(h); rec(h); } };
  rec(raiz);
  if (sel === ':scope > .tab-btn') return raiz._hijos.filter(h => h._clases.has('tab-btn'));
  if (sel === '.tab-btn')      return todos.filter(h => h._clases.has('tab-btn'));
  if (sel === '.nav-seccion')  return todos.filter(h => h._clases.has('nav-seccion'));
  if (sel === '.bnav-item')    return todos.filter(h => h._clases.has('bnav-item'));
  if (sel === '[data-modulo]')     return todos.filter(h => 'modulo' in h.dataset && h.dataset.modulo != null);
  if (sel === '[data-modulo-any]') return todos.filter(h => 'moduloAny' in h.dataset && h.dataset.moduloAny != null);
  if (sel === '.admin-only')   return todos.filter(h => h._clases.has('admin-only'));
  return [];
}

// Construye el DOM del sidebar + drawer + bottom-nav a partir del markup real.
function construirEntorno() {
  const byId = new Map();
  const reg = (el) => { if (el.id) byId.set(el.id, el); return el; };

  const sidebar = crearEl('div'); sidebar.id = 'tabs-nav'; reg(sidebar);
  const mkTab = (b) => {
    const el = crearEl('button'); el.id = b.id;
    b.clases.forEach(c => el._clases.add(c));
    if (b.modulo) el.dataset.modulo = b.modulo;
    if (b.moduloAny) el.dataset.moduloAny = b.moduloAny;
    el._texto = b.label;
    return reg(el);
  };
  const meta = Object.fromEntries(TODOS.map(b => [b.id, b]));
  for (const id of SUELTOS) sidebar.appendChild(mkTab(meta[id]));
  for (const sec of SECCIONES) {
    const grp = crearEl('button'); grp.id = 'navgrp-' + sec.clave; grp._texto = '▾' + sec.clave; reg(grp);
    sidebar.appendChild(grp);
    const secEl = crearEl('div'); secEl.id = 'navsec-' + sec.clave; secEl._clases.add('nav-seccion'); reg(secEl);
    for (const id of sec.tabs) secEl.appendChild(mkTab(meta[id]));
    sidebar.appendChild(secEl);
  }

  // Contenedor del drawer y de la barra inferior (para el DOM global).
  const raiz = crearEl('div');
  raiz.appendChild(sidebar);
  const masLista = crearEl('div'); masLista.id = 'mas-lista'; reg(masLista); raiz.appendChild(masLista);
  const bnav = crearEl('nav'); bnav.id = 'bottom-nav';
  for (const bid of ['bnav-comandas', 'bnav-chats', 'bnav-corte']) {
    const b = crearEl('button'); b.id = bid; b._clases.add('bnav-item'); bnav.appendChild(b);
  }
  raiz.appendChild(bnav);
  reg(crearEl('button')).id; // no-op

  const document = {
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (sel) => selEn(raiz, sel),
    createElement: (tag) => crearEl(tag),
  };
  return { document, sidebar, masLista, byId };
}

// Carga las funciones reales sobre un entorno, con MODULOS/ROL dados.
function cargar(entorno, MODULOS, ROL) {
  const noop = () => {};
  const fabrica = new Function('document', 'MODULOS', 'cerrarMasSheet', `
    ${SRC_APLICAR}
    ${SRC_DRAWER}
    return { aplicarModulosUI, construirDrawerMovil, DRAWER_EXCLUIR, NAV_ICONOS };
  `);
  const api = fabrica(entorno.document, MODULOS, noop);
  // Espeja el paso de admin-only del flujo de auth real (server: si ROL!==admin
  // se ocultan los .admin-only ANTES de construir el drawer).
  if (ROL !== 'admin') {
    entorno.document.querySelectorAll('.admin-only').forEach(el => { el.style.display = 'none'; });
  }
  api.aplicarModulosUI();
  api.construirDrawerMovil();
  return api;
}

// Etiquetas del drawer resultante.
function drawerLabels(entorno) {
  return entorno.masLista._hijos
    .filter(h => h._clases.has('mas-item'))
    .map(h => h.textContent.trim());
}
function drawerTieneAccionHacia(entorno, tabId) {
  // Cada item del drawer, al hacer click, debe invocar el .click() del tab del
  // sidebar correspondiente (misma acción, una sola definición).
  const items = entorno.masLista._hijos.filter(h => h._clases.has('mas-item'));
  const meta = Object.fromEntries(TODOS.map(b => [b.id, b]));
  const label = meta[tabId]?.label;
  const item = items.find(h => h.textContent.trim() === label);
  if (!item) return false;
  const btn = entorno.byId.get(tabId);
  const antes = btn._clicks;
  item.click();
  return btn._clicks === antes + 1;
}

// Módulos que cubren TODOS los data-modulo del sidebar (negocio "todo activo").
const TODOS_MODULOS = [...new Set(TODOS.flatMap(b =>
  [b.modulo, ...(b.moduloAny ? b.moduloAny.split(',') : [])].filter(Boolean)))];

// ─── 1. El drawer ya no tiene lista fija propia ──────────────────────────────
t('1. el drawer se genera (no hay lista de módulos escrita a mano)', () => {
  const masSheet = html.match(/<div id="mas-sheet">([\s\S]*?)\n<\/div>/);
  assert.ok(masSheet, 'no se encontró #mas-sheet');
  const cuerpo = masSheet[1];
  assert.ok(/id="mas-lista"/.test(cuerpo), '#mas-sheet debe contener el contenedor generado #mas-lista');
  assert.ok(!/class="mas-item"/.test(cuerpo),
    'quedan .mas-item estáticos en el HTML: el drawer volvió a tener lista propia');
  assert.ok(!/bnavTab\('(historial|ventas|menu|config|clientes|usuarios|repartidores)'\)/.test(cuerpo),
    'quedan acciones de navegación hardcodeadas en el HTML del drawer');
});

// ─── 2. El drawer se deriva del sidebar y se llama tras los gates ─────────────
t('2. construirDrawerMovil se invoca después de aplicarModulosUI', () => {
  const flujo = html.match(/aplicarModulosUI\(\);[\s\S]{0,400}?construirDrawerMovil\(\);/);
  assert.ok(flujo, 'construirDrawerMovil() debe llamarse después de aplicarModulosUI() en el flujo de auth');
});

// ─── 3. Exclusión mínima = solo lo que ya está en la barra inferior ──────────
t('3. el drawer solo excluye los tabs que ya viven en la barra inferior', () => {
  const e = construirEntorno();
  const api = cargar(e, TODOS_MODULOS, 'admin');
  const excl = [...api.DRAWER_EXCLUIR].sort();
  assert.deepStrictEqual(excl, ['tab-chats', 'tab-comandas', 'tab-corte'],
    `la exclusión del drawer debe ser exactamente los tabs de la barra inferior, es: ${excl.join(',')}`);
});

// ─── 4. PARIDAD: todo tab visible en desktop es alcanzable en móvil ──────────
t('4. paridad admin/todo-activo: cada tab del sidebar llega a móvil', () => {
  const e = construirEntorno();
  cargar(e, TODOS_MODULOS, 'admin');
  const enDrawer = new Set(drawerLabels(e));
  const bottom = new Set(['tab-comandas', 'tab-chats', 'tab-corte']);
  const meta = Object.fromEntries(TODOS.map(b => [b.id, b]));
  const ausentes = [];
  for (const b of TODOS) {
    if (bottom.has(b.id)) continue;             // ya en barra inferior
    if (!enDrawer.has(meta[b.id].label)) ausentes.push(b.id);
  }
  assert.deepStrictEqual(ausentes, [],
    `estos tabs de desktop NO son alcanzables en móvil: ${ausentes.join(', ')}`);
});

// ─── 5. Caso de aceptación del usuario: Promociones ──────────────────────────
t('5. Promociones (tab-tienda) aparece en móvil y abre la misma sección', () => {
  const e = construirEntorno();
  cargar(e, ['menu', 'pos', 'tienda_online', 'whatsapp'], 'admin');
  const labels = drawerLabels(e);
  assert.ok(labels.includes('Tienda en línea') || labels.includes('Promociones'),
    `el drawer no expone Tienda/Promociones. Items: ${labels.join(', ')}`);
  assert.ok(drawerTieneAccionHacia(e, 'tab-tienda'),
    'el item de Promociones no dispara la acción del tab de Tienda del sidebar');
});

// ─── 6. Relabel: sin tienda_online, "Tienda en línea" → "Promociones" ────────
t('6. sin tienda_online pero con menu/pos, el item se llama "Promociones"', () => {
  const e = construirEntorno();
  cargar(e, ['menu', 'pos'], 'admin');
  const labels = drawerLabels(e);
  assert.ok(labels.includes('Promociones'),
    `esperaba "Promociones" (relabel) en el drawer. Items: ${labels.join(', ')}`);
  assert.ok(!labels.includes('Tienda en línea'), 'no debería quedar "Tienda en línea" cuando no hay tienda_online');
});

// ─── 7. Gates: no aparece lo no habilitado ───────────────────────────────────
t('7. un módulo no habilitado NO aparece en el drawer', () => {
  const e = construirEntorno();
  cargar(e, ['menu', 'pos'], 'admin'); // sin rewards, sin voz, sin usuarios...
  const labels = drawerLabels(e);
  assert.ok(!labels.includes('Rewards'), 'Rewards no debería aparecer sin el módulo rewards');
  assert.ok(!labels.includes('Llamadas'), 'Llamadas no debería aparecer sin el módulo voz');
  assert.ok(!labels.includes('Usuarios'), 'Usuarios no debería aparecer sin el módulo usuarios');
});

// ─── 8. Rol: un operador no ve entradas admin-only ───────────────────────────
t('8. un operador (no admin) no ve en móvil las entradas admin-only', () => {
  const e = construirEntorno();
  cargar(e, TODOS_MODULOS, 'staff');
  const labels = drawerLabels(e);
  // Historial es admin-only en el sidebar: no debe llegar al drawer del operador.
  assert.ok(!labels.includes('Historial'),
    `un operador no debería ver Historial (admin-only). Items: ${labels.join(', ')}`);
});

// ─── 9. Invariante estructural declarado ─────────────────────────────────────
t('9. sidebar_tabs ⊆ (barra_inferior ∪ tabs_derivables_al_drawer)', () => {
  // Con todo habilitado y admin, ningún tab del sidebar puede quedar fuera de
  // la unión barra-inferior + drawer. Es el invariante de no-regresión: si
  // mañana se agrega un tab nuevo al sidebar, o llega a la barra inferior o
  // llega al drawer — nunca desaparece de móvil.
  const e = construirEntorno();
  cargar(e, TODOS_MODULOS, 'admin');
  const drawer = new Set(drawerLabels(e));
  const bottom = new Set(['tab-comandas', 'tab-chats', 'tab-corte']);
  const meta = Object.fromEntries(TODOS.map(b => [b.id, b]));
  const huerfanos = TODOS.filter(b => !bottom.has(b.id) && !drawer.has(meta[b.id].label)).map(b => b.id);
  assert.strictEqual(huerfanos.length, 0, `tabs huérfanos (ni barra inferior ni drawer): ${huerfanos.join(', ')}`);
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
