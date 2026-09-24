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
const navHtml = html.match(/<div id="tabs-nav">([\s\S]*?)\n<\/div>\n\n<main[^>]*>/);
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
      // Sin los contadores (<span class="nav-contador">), igual que el drawer.
      label: m[2].replace(/<span class="nav-contador"[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '').replace(/&#x[0-9A-Fa-f]+;|&#\d+;/g, m => m).replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

const TODOS = parseBotones(NAV);
// Control de lectura: desde la Fase 2 varias pantallas son pestañas de una
// sección y ya no tienen botón propio en el sidebar.
assert.ok(TODOS.length >= 10, `esperaba ≥10 tabs en el sidebar, hallé ${TODOS.length}`);

// Estructura de primer nivel del sidebar, EN SU ORDEN: tabs sueltos (Inicio),
// secciones plegables con sus tabs y el pie (Configuración). La alternancia
// consume cada bloque entero, así que un tab anidado no se cuenta dos veces.
const ESTRUCTURA = [];
for (const m of NAV.matchAll(/<div class="nav-seccion" id="navsec-([a-z]+)"[^>]*>([\s\S]*?)\n  <\/div>|<div class="nav-pie">([\s\S]*?)\n  <\/div>|<button\b[^>]*\bclass="tab-btn[^"]*"[^>]*>[\s\S]*?<\/button>/g)) {
  if (m[1]) ESTRUCTURA.push({ tipo: 'seccion', clave: m[1], tabs: parseBotones(m[2]).map(b => b.id) });
  else if (m[3] !== undefined) ESTRUCTURA.push({ tipo: 'pie', tabs: parseBotones(m[3]).map(b => b.id) });
  else ESTRUCTURA.push({ tipo: 'suelto', tabs: parseBotones(m[0]).map(b => b.id) });
}
const SECCIONES = ESTRUCTURA.filter(n => n.tipo === 'seccion');
assert.deepStrictEqual(ESTRUCTURA.flatMap(n => n.tabs).sort(), TODOS.map(b => b.id).sort(),
  'la lectura por bloques del sidebar no cubre exactamente sus tabs');

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
  Object.defineProperty(el, 'children', { get: () => el._hijos.slice() });
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
  for (const nodo of ESTRUCTURA) {
    if (nodo.tipo === 'suelto') { nodo.tabs.forEach(id => sidebar.appendChild(mkTab(meta[id]))); continue; }
    if (nodo.tipo === 'pie') {
      const pie = crearEl('div'); pie._clases.add('nav-pie');
      nodo.tabs.forEach(id => pie.appendChild(mkTab(meta[id])));
      sidebar.appendChild(pie);
      continue;
    }
    const grp = crearEl('button'); grp.id = 'navgrp-' + nodo.clave; grp._texto = '▾' + nodo.clave; reg(grp);
    sidebar.appendChild(grp);
    const secEl = crearEl('div'); secEl.id = 'navsec-' + nodo.clave; secEl._clases.add('nav-seccion'); reg(secEl);
    for (const id of nodo.tabs) secEl.appendChild(mkTab(meta[id]));
    sidebar.appendChild(secEl);
  }

  // Contenedor del drawer y de la barra inferior (para el DOM global).
  const raiz = crearEl('div');
  raiz.appendChild(sidebar);
  const masLista = crearEl('div'); masLista.id = 'mas-lista'; reg(masLista); raiz.appendChild(masLista);
  const bnav = crearEl('nav'); bnav.id = 'bottom-nav';
  for (const bid of ['bnav-comandas', 'bnav-chats', 'bnav-corte']) {
    const b = crearEl('button'); b.id = bid; b._clases.add('bnav-item');
    // Mismos permisos que el botón real: el drawer omite un tab solo mientras
    // su entrada de la barra se ve.
    const real = html.match(new RegExp(`<button class="bnav-item([^"]*)" id="${bid}"([^>]*)>`));
    assert.ok(real, `no se encontró ${bid} en la barra inferior`);
    real[1].split(/\s+/).filter(Boolean).forEach(c => b._clases.add(c));
    const modulo = real[2].match(/data-modulo="([^"]+)"/);
    if (modulo) b.dataset.modulo = modulo[1];
    reg(b); bnav.appendChild(b);
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
  const fabrica = new Function('document', 'MODULOS', 'cerrarMasSheet', 'ROL', `
    ${SRC_APLICAR}
    ${SRC_DRAWER}
    return { aplicarModulosUI, aplicarRolUI, construirDrawerMovil, DRAWER_EXCLUIR, NAV_ICONOS };
  `);
  const api = fabrica(entorno.document, MODULOS, noop, ROL);
  // El paso de rol REAL del flujo de auth (aplicarRolUI: admin-only, y lo que
  // el cajero sí ve), ANTES de construir el drawer.
  api.aplicarRolUI();
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
// Todos los módulos que el panel usa, no solo los del menú lateral: desde la
// Fase 2 el de WhatsApp vive en la pestaña Conversaciones y en la barra del
// celular, ya no en el botón Chats.
const TODOS_MODULOS = [...new Set([
  ...TODOS.flatMap(b => [b.modulo, ...(b.moduloAny ? b.moduloAny.split(',') : [])]),
  ...[...html.matchAll(/data-modulo="([^"]+)"/g)].map(m => m[1]),
].filter(Boolean))];

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
  // Cada tab excluido, con la entrada de la barra que lo sustituye.
  assert.deepStrictEqual(api.DRAWER_EXCLUIR, { 'tab-comandas': 'bnav-comandas', 'tab-chats': 'bnav-chats', 'tab-corte': 'bnav-corte' },
    `la exclusión del drawer debe ser exactamente los tabs de la barra inferior, es: ${JSON.stringify(api.DRAWER_EXCLUIR)}`);
});

// Fase 2.2: Chats agrupa Conversaciones (módulo whatsapp) y el Bot (sin
// módulo). A un admin sin WhatsApp la barra inferior no le muestra Chats: el
// drawer tiene que dárselo, o el Bot dejaría de alcanzarse en el celular.
t('3b. sin WhatsApp, Chats entra al drawer (ahí vive el Bot); con WhatsApp no se repite', () => {
  const sin = construirEntorno();
  cargar(sin, TODOS_MODULOS.filter(m => m !== 'whatsapp'), 'admin');
  assert.ok(drawerLabels(sin).includes('Chats'), `drawer sin WhatsApp: ${drawerLabels(sin).join(', ')}`);
  const con = construirEntorno();
  cargar(con, TODOS_MODULOS, 'admin');
  assert.ok(!drawerLabels(con).includes('Chats'), 'con WhatsApp, Chats sale en el drawer y en la barra');
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

// ─── 10. El drawer respeta el ORDEN del sidebar ──────────────────────────────
t('10. el drawer sigue el orden del sidebar: Configuración al final, no arriba', () => {
  // Antes el drawer ponía primero TODOS los tabs sueltos y después los grupos:
  // con Configuración como pie suelto, habría quedado arriba de todo en móvil.
  const e = construirEntorno();
  cargar(e, TODOS_MODULOS, 'admin');
  const meta = Object.fromEntries(TODOS.map(b => [b.id, b]));
  const bottom = new Set(['tab-comandas', 'tab-chats', 'tab-corte']);
  const esperado = ESTRUCTURA.flatMap(n => n.tabs).filter(id => !bottom.has(id)).map(id => meta[id].label);
  const labels = drawerLabels(e);
  assert.deepStrictEqual(labels, esperado, `orden del drawer distinto al del sidebar: ${labels.join(' · ')}`);
  assert.strictEqual(labels[labels.length - 1], 'Configuración', 'Configuración no quedó al final del drawer');
});

// ─── 11. El operador en el móvil: solo pedidos y mesas ───────────────────────
t('11. en el móvil el operador solo tiene Pedidos, Nuevo pedido y Mesas', () => {
  // Regla del dueño (2026-09-24). La barra inferior no se deriva del sidebar:
  // sus botones llevan los mismos permisos a mano, y aquí se vigilan.
  const barra = html.match(/<nav id="bottom-nav">([\s\S]*?)<\/nav>/);
  assert.ok(barra, 'no se encontró la barra inferior');
  const botones = [...barra[1].matchAll(/<button class="bnav-item([^"]*)"[^>]*onclick="([^"]+)"/g)]
    .map(m => ({ adminOnly: /\badmin-only\b/.test(m[1]), accion: m[2] }));
  const paraOperador = botones.filter(b => !b.adminOnly).map(b => b.accion);
  assert.deepStrictEqual(paraOperador, ["bnavTab('comandas')", 'abrirNuevoPedido()', 'abrirMasSheet()'],
    `la barra inferior le muestra al operador: ${paraOperador.join(', ')}`);
  // Y en "Más", de todo el menú, solo Mesas (Pedidos ya está en la barra).
  const e = construirEntorno();
  cargar(e, TODOS_MODULOS, 'staff');
  assert.deepStrictEqual(drawerLabels(e), ['Mesas'], `el cajón del operador: ${drawerLabels(e).join(', ')}`);
});

// ─── 12. El cajero en el móvil (Fase 3.3) ────────────────────────────────────
t('12. en el móvil el cajero tiene Pedidos, Nuevo y Chats; en "Más", Mesas, Cotizaciones y Facturación', () => {
  // Regla del dueño (2026-09-24): el cajero ve lo del operador más Chats,
  // Historial, Facturación y Cotizaciones; nunca Caja ni totales.
  const barra = html.match(/<nav id="bottom-nav">([\s\S]*?)<\/nav>/);
  assert.ok(barra, 'no se encontró la barra inferior');
  const botones = [...barra[1].matchAll(/<button class="bnav-item([^"]*)"[^>]*onclick="([^"]+)"/g)]
    .map(m => ({ clases: m[1].split(/\s+/).filter(Boolean), accion: m[2] }));
  const paraCajero = botones.filter(b => !b.clases.includes('admin-only') || b.clases.includes('cajero-ve')).map(b => b.accion);
  assert.deepStrictEqual(paraCajero, ["bnavTab('comandas')", 'abrirNuevoPedido()', "bnavTab('chats')", 'abrirMasSheet()'],
    `la barra inferior le muestra al cajero: ${paraCajero.join(', ')}`);
  // "Más" se deriva del menú ya gateado por el paso de rol real.
  const e = construirEntorno();
  cargar(e, TODOS_MODULOS, 'cajero');
  assert.deepStrictEqual(drawerLabels(e), ['Mesas', 'Cotizaciones', 'Facturación'], `el cajón del cajero: ${drawerLabels(e).join(', ')}`);
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
