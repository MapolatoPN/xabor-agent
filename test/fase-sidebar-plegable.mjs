// Navegación lateral plegable del panel.
//
// El menú ya estaba agrupado por áreas, pero mostraba los ~17 destinos al
// mismo tiempo. Aquí se pliegan las secciones. Lo que esta suite protege NO
// es la estética: es que plegar no haya escondido ni desactivado ninguna
// opción, ni tocado permisos (admin-only / data-modulo) ni rutas.
//
// No hay jsdom en el proyecto, así que la suite arma un DOM mínimo a partir
// del MARKUP REAL del panel (parsea #tabs-nav) y ejecuta las funciones REALES
// extraídas del archivo. Si el markup y la lógica dejan de corresponderse,
// esto falla -- que es justo lo que una prueba de regex no detectaría.
import { readFileSync } from 'fs';
import assert from 'assert';

// Se normalizan los saltos de línea: en Windows git materializa el panel con
// CRLF, y esta suite lo lee buscando estructura (dónde empieza y termina el
// bloque de navegación), no bytes. Sin normalizar, la misma prueba pasa o
// falla según cómo esté configurado el checkout.
const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const HTML_PREVIO = readFileSync(new URL('./.sidebar-destinos-esperados.json', import.meta.url), 'utf8');
const DESTINOS_ESPERADOS = JSON.parse(HTML_PREVIO);

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ─── Lectura del markup real ────────────────────────────────────────────────
const navHtml = html.match(/<div id="tabs-nav">([\s\S]*?)\n<\/div>\n\n<main>/);
assert.ok(navHtml, 'no se encontró el bloque #tabs-nav en el panel');
const NAV = navHtml[1];

function botonesDe(fragmento) {
  return [...fragmento.matchAll(/<button class="tab-btn[^"]*"[^>]*id="(tab-[a-z]+)"[^>]*>/g)].map(m => m[1]);
}
const TODOS_LOS_TABS = botonesDe(NAV);

const SECCIONES = {};
for (const m of NAV.matchAll(/<div class="nav-seccion" id="navsec-([a-z]+)"[^>]*>([\s\S]*?)\n  <\/div>/g)) {
  SECCIONES[m[1]] = botonesDe(m[2]);
}

// ─── DOM mínimo sobre la estructura real ────────────────────────────────────
function construirDom({ ocultos = [], tabActivo = 'tab-comandas' } = {}) {
  const elementos = new Map();
  const crear = (id, clases, extra = {}) => {
    const el = {
      id, hidden: false, style: { display: '' },
      _clases: new Set(clases), _attrs: {},
      classList: {
        add: (c) => el._clases.add(c),
        remove: (c) => el._clases.delete(c),
        contains: (c) => el._clases.has(c),
      },
      setAttribute: (k, v) => { el._attrs[k] = String(v); },
      getAttribute: (k) => (k in el._attrs ? el._attrs[k] : null),
      ...extra,
    };
    elementos.set(id, el);
    return el;
  };

  for (const clave of Object.keys(SECCIONES)) {
    crear('navgrp-' + clave, ['nav-grupo'], { _attrs: { 'aria-expanded': 'true', 'aria-controls': 'navsec-' + clave } });
    const hijos = SECCIONES[clave].map(idTab => crear(idTab, ['tab-btn']));
    const sec = elementos.get('navsec-' + clave) || crear('navsec-' + clave, ['nav-seccion']);
    sec.querySelectorAll = (sel) => (sel === '.tab-btn' ? hijos : []);
  }
  for (const idTab of TODOS_LOS_TABS) if (!elementos.has(idTab)) crear(idTab, ['tab-btn']);
  for (const idTab of ocultos) elementos.get(idTab).style.display = 'none';
  if (elementos.has(tabActivo)) elementos.get(tabActivo).classList.add('activo');

  const almacen = new Map();
  return {
    elementos,
    document: {
      getElementById: (id) => elementos.get(id) || null,
      querySelector: (sel) => {
        if (sel === '#tabs-nav .tab-btn.activo') {
          for (const id of TODOS_LOS_TABS) {
            const el = elementos.get(id);
            if (el && el.classList.contains('activo')) return el;
          }
        }
        return null;
      },
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: (k) => (almacen.has(k) ? almacen.get(k) : null),
      setItem: (k, v) => almacen.set(k, String(v)),
      _crudo: () => almacen,
    },
  };
}

// ─── Extracción de las funciones reales ─────────────────────────────────────
const bloque = html.match(/const NAV_GRUPOS = [\s\S]*?\nfunction mostrarTab\(tab\) \{/);
assert.ok(bloque, 'no se encontró el bloque de navegación plegable en el panel');
const FUENTE_NAV = bloque[0].replace(/\nfunction mostrarTab\(tab\) \{$/, '');

function cargarNav(entorno) {
  const fabrica = new Function('document', 'localStorage', 'window', `
    ${FUENTE_NAV}
    return { toggleGrupoNav, restaurarGruposNav, abrirGrupoDelTab, aplicarGrupoNav,
             ocultarGruposNavVacios, navPreferencias, NAV_GRUPOS, NAV_GRUPO_DE_TAB };
  `);
  return fabrica(entorno.document, entorno.localStorage, entorno.window || { innerWidth: 1440 });
}

// ─── 1. Ninguna opción desapareció ──────────────────────────────────────────
t('1. todas las rutas/destinos siguen existiendo en el markup', () => {
  for (const destino of DESTINOS_ESPERADOS.tabs) {
    assert.ok(TODOS_LOS_TABS.includes(destino), `desapareció el destino ${destino}`);
  }
  assert.strictEqual(TODOS_LOS_TABS.length, DESTINOS_ESPERADOS.tabs.length,
    `cambió la cantidad de destinos: ${TODOS_LOS_TABS.join(',')}`);
});

t('2. cada destino conserva su onclick y su vista', () => {
  for (const [idTab, accion] of Object.entries(DESTINOS_ESPERADOS.acciones)) {
    const re = new RegExp(`id="${idTab}"[^>]*onclick="${accion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
    assert.match(NAV, re, `${idTab} perdió su acción ${accion}`);
  }
});

t('3. los permisos siguen exactamente donde estaban', () => {
  for (const idTab of DESTINOS_ESPERADOS.adminOnly) {
    assert.match(NAV, new RegExp(`class="tab-btn admin-only"[^>]*id="${idTab}"`), `${idTab} perdió admin-only`);
  }
  for (const [idTab, modulo] of Object.entries(DESTINOS_ESPERADOS.modulos)) {
    assert.match(NAV, new RegExp(`id="${idTab}"\\s+data-modulo="${modulo}"`), `${idTab} perdió data-modulo=${modulo}`);
  }
});

t('4. "+ Nuevo pedido" queda fuera de toda sección plegable', () => {
  assert.match(NAV, /<button class="nav-nuevo-pedido" id="btn-nuevo-pedido"/);
  const antesDelPrimerGrupo = NAV.split('<button type="button" class="nav-grupo"')[0];
  assert.ok(antesDelPrimerGrupo.includes('id="btn-nuevo-pedido"'),
    'el botón primario quedó dentro de una sección que se puede cerrar');
  assert.ok(antesDelPrimerGrupo.includes('id="tab-inicio"'), 'Inicio debería quedar siempre visible');
});

t('5. no hay ids duplicados en la navegación', () => {
  const ids = [...NAV.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepStrictEqual(repetidos, [], `ids duplicados: ${repetidos.join(', ')}`);
});

// ─── Accesibilidad del markup ───────────────────────────────────────────────
t('6. cada encabezado es un button accesible con aria correcto', () => {
  for (const clave of Object.keys(SECCIONES)) {
    const re = new RegExp(`<button type="button" class="nav-grupo" id="navgrp-${clave}" aria-expanded="(true|false)" aria-controls="navsec-${clave}"`);
    assert.match(NAV, re, `encabezado ${clave} mal formado`);
    assert.match(NAV, new RegExp(`id="navsec-${clave}"[^>]*role="group"[^>]*aria-labelledby="navgrp-${clave}"`),
      `sección ${clave} sin relación aria con su encabezado`);
  }
  assert.ok(!/<div class="nav-grupo">/.test(NAV), 'quedó un encabezado como div (no llega por teclado)');
});

// ─── Comportamiento real ────────────────────────────────────────────────────
t('7. abrir y cerrar funciona y mueve aria-expanded y hidden juntos', () => {
  const env = construirDom();                       // destino activo: Pedidos (Operación)
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  const cab = env.elementos.get('navgrp-administracion');
  const sec = env.elementos.get('navsec-administracion');
  // Arranca cerrada: es el default, y el destino activo vive en otra sección.
  assert.strictEqual(cab.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(sec.hidden, true);
  nav.toggleGrupoNav('administracion');
  assert.strictEqual(cab.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(sec.hidden, false, 'aria dice abierta pero la sección sigue oculta');
  nav.toggleGrupoNav('administracion');
  assert.strictEqual(cab.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(sec.hidden, true, 'aria dice cerrada pero la sección sigue visible');
});

t('8. la sección del destino activo se abre aunque estuviera guardada cerrada', () => {
  const env = construirDom({ tabActivo: 'tab-corte' });
  env.localStorage.setItem('xaborNavGrupos', JSON.stringify({
    operacion: false, catalogo: false, clientes: false,
    automatizacion: false, administracion: false, configuracion: false,
  }));
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  assert.strictEqual(env.elementos.get('navsec-administracion').hidden, false,
    'la sección del destino activo (Corte) quedó cerrada');
  assert.strictEqual(env.elementos.get('navgrp-administracion').getAttribute('aria-expanded'), 'true');
  // Las demás sí respetan lo guardado.
  assert.strictEqual(env.elementos.get('navsec-clientes').hidden, true);
});

t('9. abrir la sección activa NO pisa la preferencia guardada del usuario', () => {
  const env = construirDom({ tabActivo: 'tab-corte' });
  env.localStorage.setItem('xaborNavGrupos', JSON.stringify({ administracion: false }));
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  const guardado = JSON.parse(env.localStorage.getItem('xaborNavGrupos'));
  assert.strictEqual(guardado.administracion, false,
    'la apertura de cortesía se guardó como si el usuario la hubiera pedido');
});

t('10. localStorage persiste y restaura la preferencia', () => {
  const env = construirDom();
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  nav.toggleGrupoNav('clientes');          // el usuario ABRE dos secciones
  nav.toggleGrupoNav('automatizacion');
  nav.toggleGrupoNav('operacion');         // y CIERRA la que venía abierta
  const guardado = JSON.parse(env.localStorage.getItem('xaborNavGrupos'));
  assert.strictEqual(guardado.clientes, true);
  assert.strictEqual(guardado.automatizacion, true);
  assert.strictEqual(guardado.operacion, false);

  // Nueva "recarga" con el mismo almacenamiento: manda lo que el usuario dejó,
  // no el default.
  const env2 = construirDom({ tabActivo: 'tab-chats' });   // activo dentro de Clientes
  env2.localStorage.setItem('xaborNavGrupos', JSON.stringify(guardado));
  const nav2 = cargarNav(env2);
  nav2.restaurarGruposNav();
  assert.strictEqual(env2.elementos.get('navsec-clientes').hidden, false, 'no restauró lo abierto');
  assert.strictEqual(env2.elementos.get('navsec-automatizacion').hidden, false, 'no restauró lo abierto');
  assert.strictEqual(env2.elementos.get('navsec-operacion').hidden, true, 'abrió algo que el usuario cerró');
  // Y una sección sin preferencia guardada sigue el default: cerrada.
  assert.strictEqual(env2.elementos.get('navsec-configuracion').hidden, true);
});

t('11. una preferencia corrupta no rompe la navegación', () => {
  for (const basura of ['no-es-json', '[]', 'null', '42', '{"clientes":"quizás"}']) {
    const env = construirDom();
    env.localStorage.setItem('xaborNavGrupos', basura);
    const nav = cargarNav(env);
    nav.restaurarGruposNav();
    for (const clave of Object.keys(SECCIONES)) {
      const cab = env.elementos.get('navgrp-' + clave);
      assert.ok(['true', 'false'].includes(cab.getAttribute('aria-expanded')),
        `con basura ${basura} la sección ${clave} quedó en estado indefinido`);
    }
    // Y el destino activo siempre visible, pase lo que pase.
    assert.strictEqual(env.elementos.get('navsec-operacion').hidden, false);
  }
});

t('12. sin preferencia guardada, solo queda abierta la sección del destino activo', () => {
  const env = construirDom({ tabActivo: 'tab-menu' });
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  assert.strictEqual(env.elementos.get('navsec-catalogo').hidden, false, 'la sección del destino activo debe abrirse');
  for (const clave of Object.keys(SECCIONES)) {
    if (clave === 'catalogo') continue;
    assert.strictEqual(env.elementos.get('navsec-' + clave).hidden, true,
      `${clave} debería arrancar cerrada: el menú tiene que verse compacto de entrada`);
  }
  // Y el usuario nunca aterriza en un menú completamente plegado.
  const abiertas = Object.keys(SECCIONES).filter(c => !env.elementos.get('navsec-' + c).hidden);
  assert.deepStrictEqual(abiertas, ['catalogo']);
});

t('13. el ancho de la pantalla ya no cambia el estado inicial', () => {
  // Antes, en monitor se abrían las seis secciones "porque había espacio" --
  // y el menú quedaba tan saturado como antes del cambio. El default es
  // ahora el mismo en cualquier ancho.
  const estadoCon = (ancho) => {
    const env = construirDom({ tabActivo: 'tab-corte' });
    env.window = { innerWidth: ancho };
    cargarNav(env).restaurarGruposNav();
    return Object.keys(SECCIONES).map(c => `${c}:${env.elementos.get('navsec-' + c).hidden}`);
  };
  assert.deepStrictEqual(estadoCon(1600), estadoCon(900), 'el default sigue dependiendo del ancho');
  assert.deepStrictEqual(estadoCon(1600), estadoCon(1099));
  // En monitor ancho también: solo Administración (donde vive Corte).
  const enMonitor = estadoCon(1600);
  assert.deepStrictEqual(enMonitor.filter(e => e.endsWith(':false')), ['administracion:false']);
  // Y la lógica ya no consulta el ancho en ninguna parte.
  assert.ok(!/innerWidth/.test(FUENTE_NAV), 'la navegación sigue ramificando por ancho de pantalla');
});

t('14. una sección sin destinos visibles se oculta completa', () => {
  // Operador (no admin): Administración queda sin ningún destino.
  const env = construirDom({ ocultos: ['tab-ventas', 'tab-corte', 'tab-usuarios'] });
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  assert.strictEqual(env.elementos.get('navgrp-administracion').style.display, 'none',
    'quedó un encabezado que no abre nada');
  assert.strictEqual(env.elementos.get('navsec-administracion').hidden, true);
  // Y una sección con al menos un destino visible se conserva.
  assert.strictEqual(env.elementos.get('navgrp-operacion').style.display, '');
});

t('15. el mapa tab -> sección cubre todos los destinos plegables', () => {
  const env = construirDom();
  const nav = cargarNav(env);
  for (const [clave, tabs] of Object.entries(SECCIONES)) {
    for (const idTab of tabs) {
      const destino = idTab.replace(/^tab-/, '');
      assert.strictEqual(nav.NAV_GRUPO_DE_TAB[destino], clave,
        `${destino} está en la sección ${clave} pero el mapa dice ${nav.NAV_GRUPO_DE_TAB[destino]}`);
    }
  }
  assert.deepStrictEqual(nav.NAV_GRUPOS.slice().sort(), Object.keys(SECCIONES).sort());
});

t('16. mostrarTab abre la sección del destino al que se navega', () => {
  assert.match(html, /if \(tabEl\) tabEl\.classList\.add\('activo'\);\s*\n\s*abrirGrupoDelTab\(tab\);/,
    'mostrarTab ya no abre la sección del destino activo');
  assert.match(html, /aplicarModulosUI\(\);[\s\S]{0,220}restaurarGruposNav\(\);/,
    'el plegado debe restaurarse DESPUÉS de aplicar permisos');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
