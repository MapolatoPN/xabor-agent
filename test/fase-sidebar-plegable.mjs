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
const navHtml = html.match(/<div id="tabs-nav">([\s\S]*?)\n<\/div>\n\n<main[^>]*>/);
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
const PIE = botonesDe((NAV.match(/<div class="nav-pie">([\s\S]*?)\n  <\/div>/) || [, ''])[1]);
// Secciones FIJAS (siempre abiertas: su encabezado no es un botón) y
// PLEGABLES (encabezado <button> con aria-expanded).
const FIJAS = [...NAV.matchAll(/<div class="nav-grupo nav-grupo-fijo" id="navgrp-([a-z]+)"/g)].map(m => m[1]);
const PLEGABLES = Object.keys(SECCIONES).filter(clave => !FIJAS.includes(clave));

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
    if (FIJAS.includes(clave)) crear('navgrp-' + clave, ['nav-grupo', 'nav-grupo-fijo']);
    else crear('navgrp-' + clave, ['nav-grupo'], { _attrs: { 'aria-expanded': 'true', 'aria-controls': 'navsec-' + clave } });
    const hijos = SECCIONES[clave].map(idTab => crear(idTab, ['tab-btn']));
    const sec = elementos.get('navsec-' + clave) || crear('navsec-' + clave, ['nav-seccion']);
    sec.querySelectorAll = (sel) => (sel === '.tab-btn' ? hijos : []);
  }
  for (const idTab of TODOS_LOS_TABS) if (!elementos.has(idTab)) crear(idTab, ['tab-btn']);
  // El pie (Configuración), con los MISMOS objetos de tab: así ocultarlos
  // por permisos se ve también desde el pie.
  const pie = crear('nav-pie', ['nav-pie']);
  const hijosPie = PIE.map(idTab => elementos.get(idTab));
  pie.querySelectorAll = (sel) => (sel === '.tab-btn' ? hijosPie : []);
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
      querySelectorAll: (sel) => (sel === '#tabs-nav .nav-pie' ? [pie] : []),
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
             ocultarGruposNavVacios, navPreferencias, NAV_GRUPOS, NAV_GRUPOS_FIJOS, NAV_GRUPO_DE_TAB, NAV_PADRE_DE_TAB };
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
  for (const [idTab, modulos] of Object.entries(DESTINOS_ESPERADOS.modulosAny)) {
    assert.match(NAV, new RegExp(`id="${idTab}"\\s+data-modulo-any="${modulos}"`), `${idTab} perdió data-modulo-any=${modulos}`);
  }
});

// Salir del menú lateral no es desaparecer: cada vista que dejó de tener
// entrada propia se sigue abriendo, con la MISMA acción y los MISMOS
// permisos, desde una tarjeta de la portada de Configuración.
t('3b. las vistas que salieron del menú siguen alcanzables desde Configuración', () => {
  const portada = html.match(/<div id="config-portada">([\s\S]*?)\n      <\/div>\n/);
  assert.ok(portada, 'no se encontró la portada de Configuración');
  const nav = cargarNav(construirDom());
  for (const [vista, esperado] of Object.entries(DESTINOS_ESPERADOS.fueraDelMenu)) {
    assert.ok(!TODOS_LOS_TABS.includes('tab-' + vista), `${vista} volvió al menú lateral y además está en Configuración`);
    const tarjeta = portada[1].match(new RegExp(`<button class="cfg-card([^"]*)" id="${esperado.tarjeta}"([^>]*)>`));
    assert.ok(tarjeta, `falta la tarjeta ${esperado.tarjeta} en la portada de Configuración`);
    assert.ok(tarjeta[2].includes(`onclick="${esperado.accion}"`), `${esperado.tarjeta} no abre ${esperado.accion}`);
    if (esperado.adminOnly) assert.ok(tarjeta[1].includes('admin-only'), `${esperado.tarjeta} perdió admin-only`);
    if (esperado.modulo) assert.ok(tarjeta[2].includes(`data-modulo="${esperado.modulo}"`), `${esperado.tarjeta} perdió data-modulo=${esperado.modulo}`);
    assert.ok(html.includes(`id="vista-${vista}"`), `la vista ${vista} ya no existe`);
    assert.strictEqual(nav.NAV_PADRE_DE_TAB[vista], 'config',
      `mientras se ve ${vista} el menú debe marcar Configuración`);
  }
  // Y mostrarTab usa ese mapa cuando la vista no tiene botón propio.
  assert.match(html, /const tabEl = document\.getElementById\('tab-' \+ tab\) \|\| document\.getElementById\('tab-' \+ \(NAV_PADRE_DE_TAB\[tab\] \|\| ''\)\);/,
    'mostrarTab ya no marca la pantalla padre de las vistas sin entrada propia');
});

t('4. "+ Nuevo pedido" queda fuera de toda sección, e Inicio en una que no se pliega', () => {
  assert.match(NAV, /<button class="nav-nuevo-pedido" id="btn-nuevo-pedido"/);
  const antesDelPrimerGrupo = NAV.split('class="nav-grupo')[0];
  assert.ok(antesDelPrimerGrupo.includes('id="btn-nuevo-pedido"'),
    'el botón primario quedó dentro de una sección');
  const seccionDeInicio = Object.keys(SECCIONES).find(clave => SECCIONES[clave].includes('tab-inicio'));
  assert.ok(FIJAS.includes(seccionDeInicio), `Inicio quedó en una sección que se puede cerrar (${seccionDeInicio})`);
});

t('4b. Configuración queda fija al final, fuera de toda sección plegable', () => {
  const pie = NAV.match(/<div class="nav-pie">([\s\S]*?)\n  <\/div>\s*$/);
  assert.ok(pie, 'Configuración no está en el pie del menú (o hay algo después de él)');
  assert.deepStrictEqual(botonesDe(pie[1]), ['tab-config'], 'el pie debe llevar solo Configuración');
  for (const [clave, tabs] of Object.entries(SECCIONES)) {
    assert.ok(!tabs.includes('tab-config'), `Configuración quedó dentro de la sección plegable ${clave}`);
  }
  assert.ok(!/navgrp-configuracion/.test(NAV), 'sigue el encabezado de grupo "Configuración" con un solo destino');
});

t('5. no hay ids duplicados en la navegación', () => {
  const ids = [...NAV.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepStrictEqual(repetidos, [], `ids duplicados: ${repetidos.join(', ')}`);
});

// ─── Accesibilidad del markup ───────────────────────────────────────────────
t('6. cada encabezado plegable es un button accesible; el fijo no finge serlo', () => {
  for (const clave of PLEGABLES) {
    const re = new RegExp(`<button type="button" class="nav-grupo" id="navgrp-${clave}" aria-expanded="(true|false)" aria-controls="navsec-${clave}"`);
    assert.match(NAV, re, `encabezado ${clave} mal formado`);
  }
  for (const clave of FIJAS) {
    // No se pliega: nada de onclick ni aria-expanded que prometan otra cosa.
    const cab = NAV.match(new RegExp(`<div class="nav-grupo nav-grupo-fijo" id="navgrp-${clave}"([^>]*)>`));
    assert.ok(cab && !/onclick|aria-expanded|tabindex/.test(cab[1]), `el encabezado fijo ${clave} se comporta como botón`);
  }
  for (const clave of Object.keys(SECCIONES)) {
    assert.match(NAV, new RegExp(`id="navsec-${clave}"[^>]*role="group"[^>]*aria-labelledby="navgrp-${clave}"`),
      `sección ${clave} sin relación aria con su encabezado`);
  }
  assert.ok(!/<div class="nav-grupo">/.test(NAV), 'quedó un encabezado plegable como div (no llega por teclado)');
});

// ─── Comportamiento real ────────────────────────────────────────────────────
t('7. abrir y cerrar funciona y mueve aria-expanded y hidden juntos', () => {
  const env = construirDom();                       // destino activo: Pedidos (Día a día)
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  const cab = env.elementos.get('navgrp-finanzas');
  const sec = env.elementos.get('navsec-finanzas');
  // Arranca cerrada: es el default, y el destino activo vive en otra sección.
  assert.strictEqual(cab.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(sec.hidden, true);
  nav.toggleGrupoNav('finanzas');
  assert.strictEqual(cab.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(sec.hidden, false, 'aria dice abierta pero la sección sigue oculta');
  nav.toggleGrupoNav('finanzas');
  assert.strictEqual(cab.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(sec.hidden, true, 'aria dice cerrada pero la sección sigue visible');
});

t('8. la sección del destino activo se abre aunque estuviera guardada cerrada', () => {
  const env = construirDom({ tabActivo: 'tab-ventas' });
  env.localStorage.setItem('xaborNavGrupos', JSON.stringify({ negocio: false, finanzas: false }));
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  assert.strictEqual(env.elementos.get('navsec-finanzas').hidden, false,
    'la sección del destino activo (Ventas) quedó cerrada');
  assert.strictEqual(env.elementos.get('navgrp-finanzas').getAttribute('aria-expanded'), 'true');
  // Las demás sí respetan lo guardado.
  assert.strictEqual(env.elementos.get('navsec-negocio').hidden, true);
});

t('9. abrir la sección activa NO pisa la preferencia guardada del usuario', () => {
  const env = construirDom({ tabActivo: 'tab-ventas' });
  env.localStorage.setItem('xaborNavGrupos', JSON.stringify({ finanzas: false }));
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  const guardado = JSON.parse(env.localStorage.getItem('xaborNavGrupos'));
  assert.strictEqual(guardado.finanzas, false,
    'la apertura de cortesía se guardó como si el usuario la hubiera pedido');
});

t('10. localStorage persiste y restaura la preferencia', () => {
  const env = construirDom();
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  nav.toggleGrupoNav('negocio');           // el usuario ABRE las dos secciones
  nav.toggleGrupoNav('finanzas');
  nav.toggleGrupoNav('finanzas');          // y vuelve a CERRAR una
  const guardado = JSON.parse(env.localStorage.getItem('xaborNavGrupos'));
  assert.strictEqual(guardado.negocio, true);
  assert.strictEqual(guardado.finanzas, false);

  // Nueva "recarga" con el mismo almacenamiento: manda lo que el usuario dejó,
  // no el default.
  const env2 = construirDom({ tabActivo: 'tab-chats' });   // activo en Día a día
  env2.localStorage.setItem('xaborNavGrupos', JSON.stringify(guardado));
  const nav2 = cargarNav(env2);
  nav2.restaurarGruposNav();
  assert.strictEqual(env2.elementos.get('navsec-negocio').hidden, false, 'no restauró lo abierto');
  assert.strictEqual(env2.elementos.get('navsec-finanzas').hidden, true, 'abrió algo que el usuario cerró');
  // Y una sección sin preferencia guardada sigue el default: cerrada.
  const env3 = construirDom({ tabActivo: 'tab-chats' });
  env3.localStorage.setItem('xaborNavGrupos', JSON.stringify({ negocio: true }));
  cargarNav(env3).restaurarGruposNav();
  assert.strictEqual(env3.elementos.get('navsec-finanzas').hidden, true);
});

t('11. una preferencia corrupta no rompe la navegación', () => {
  for (const basura of ['no-es-json', '[]', 'null', '42', '{"negocio":"quizás"}']) {
    const env = construirDom();
    env.localStorage.setItem('xaborNavGrupos', basura);
    const nav = cargarNav(env);
    nav.restaurarGruposNav();
    for (const clave of PLEGABLES) {
      const cab = env.elementos.get('navgrp-' + clave);
      assert.ok(['true', 'false'].includes(cab.getAttribute('aria-expanded')),
        `con basura ${basura} la sección ${clave} quedó en estado indefinido`);
    }
    // Y lo de todos los días siempre visible, pase lo que pase.
    for (const clave of FIJAS) assert.strictEqual(env.elementos.get('navsec-' + clave).hidden, false);
  }
});

t('12. sin preferencia guardada, de lo plegable solo se abre la sección del destino activo', () => {
  const env = construirDom({ tabActivo: 'tab-menu' });
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  assert.strictEqual(env.elementos.get('navsec-negocio').hidden, false, 'la sección del destino activo debe abrirse');
  const abiertas = PLEGABLES.filter(c => !env.elementos.get('navsec-' + c).hidden);
  assert.deepStrictEqual(abiertas, ['negocio'], 'el menú tiene que verse compacto de entrada');
  // Y Día a día, abierta siempre: nadie aterriza en un menú plegado entero.
  for (const clave of FIJAS) assert.strictEqual(env.elementos.get('navsec-' + clave).hidden, false);
});

t('13. el ancho de la pantalla ya no cambia el estado inicial', () => {
  // Antes, en monitor se abrían todas las secciones "porque había espacio" --
  // y el menú quedaba tan saturado como antes del cambio. El default es
  // ahora el mismo en cualquier ancho.
  const estadoCon = (ancho) => {
    const env = construirDom({ tabActivo: 'tab-ventas' });
    env.window = { innerWidth: ancho };
    cargarNav(env).restaurarGruposNav();
    return PLEGABLES.map(c => `${c}:${env.elementos.get('navsec-' + c).hidden}`);
  };
  assert.deepStrictEqual(estadoCon(1600), estadoCon(900), 'el default sigue dependiendo del ancho');
  assert.deepStrictEqual(estadoCon(1600), estadoCon(1099));
  // En monitor ancho también: solo Finanzas (donde vive Ventas).
  const enMonitor = estadoCon(1600);
  assert.deepStrictEqual(enMonitor.filter(e => e.endsWith(':false')), ['finanzas:false']);
  // Y la lógica ya no consulta el ancho en ninguna parte.
  assert.ok(!/innerWidth/.test(FUENTE_NAV), 'la navegación sigue ramificando por ancho de pantalla');
});

t('14. una sección sin destinos visibles se oculta completa', () => {
  // Finanzas con todos sus destinos ocultos: el encabezado no debe quedar solo.
  const env = construirDom({ ocultos: ['tab-ventas', 'tab-ajustes', 'tab-compras'] });
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  assert.strictEqual(env.elementos.get('navgrp-finanzas').style.display, 'none',
    'quedó un encabezado que no abre nada');
  assert.strictEqual(env.elementos.get('navsec-finanzas').hidden, true);
  // Y una sección con al menos un destino visible se conserva.
  assert.strictEqual(env.elementos.get('navgrp-negocio').style.display, '');
  assert.strictEqual(env.elementos.get('navgrp-diadia').style.display, '');
});

t('14c. también una sección fija sin destinos visibles se oculta completa', () => {
  const env = construirDom({ ocultos: SECCIONES.diadia, tabActivo: 'tab-ventas' });
  cargarNav(env).restaurarGruposNav();
  assert.strictEqual(env.elementos.get('navgrp-diadia').style.display, 'none',
    'quedó el rótulo "Día a día" sin nada debajo');
});

t('14b. el pie sin destinos visibles (operador) no deja la línea sola', () => {
  const operador = construirDom({ ocultos: ['tab-config'] });   // Configuración es admin-only
  cargarNav(operador).restaurarGruposNav();
  assert.strictEqual(operador.elementos.get('nav-pie').style.display, 'none',
    'al operador le quedó la línea del pie sin nada debajo');
  const admin = construirDom();
  cargarNav(admin).restaurarGruposNav();
  assert.strictEqual(admin.elementos.get('nav-pie').style.display, '', 'se ocultó el pie con Configuración visible');
});

t('15. el mapa tab -> sección cubre todos los destinos plegables', () => {
  const env = construirDom();
  const nav = cargarNav(env);
  for (const clave of PLEGABLES) {
    for (const idTab of SECCIONES[clave]) {
      const destino = idTab.replace(/^tab-/, '');
      assert.strictEqual(nav.NAV_GRUPO_DE_TAB[destino], clave,
        `${destino} está en la sección ${clave} pero el mapa dice ${nav.NAV_GRUPO_DE_TAB[destino]}`);
    }
  }
  // Los de una sección fija nunca necesitan "abrirse": no están en el mapa.
  for (const clave of FIJAS) {
    for (const idTab of SECCIONES[clave]) {
      assert.strictEqual(nav.NAV_GRUPO_DE_TAB[idTab.replace(/^tab-/, '')], undefined,
        `${idTab} vive en la sección fija ${clave} pero el mapa lo manda a una plegable`);
    }
  }
  assert.deepStrictEqual(nav.NAV_GRUPOS.slice().sort(), PLEGABLES.slice().sort());
  assert.deepStrictEqual(nav.NAV_GRUPOS_FIJOS.slice().sort(), FIJAS.slice().sort());
});

t('16. mostrarTab abre la sección del destino al que se navega', () => {
  assert.match(html, /if \(tabEl\) tabEl\.classList\.add\('activo'\);\s*\n\s*abrirGrupoDelTab\(tab\);/,
    'mostrarTab ya no abre la sección del destino activo');
  // Orden dentro del flujo de sesión (el comentario entre las dos llamadas
  // puede crecer; lo que importa es quién va primero).
  const flujo = html.slice(html.indexOf("fetch('/api/auth/me'"));
  const iPermisos = flujo.indexOf('aplicarModulosUI();');
  const iPlegado = flujo.indexOf('restaurarGruposNav();');
  assert.ok(iPermisos > 0 && iPlegado > iPermisos, 'el plegado debe restaurarse DESPUÉS de aplicar permisos');
});

t('17. Día a día no se pliega por ningún camino', () => {
  assert.deepStrictEqual(FIJAS, ['diadia'], `secciones fijas: ${FIJAS.join(', ')}`);
  // Ni con una preferencia guardada que diga lo contrario...
  const env = construirDom({ tabActivo: 'tab-ventas' });
  env.localStorage.setItem('xaborNavGrupos', JSON.stringify({ diadia: false, negocio: false, finanzas: false }));
  const nav = cargarNav(env);
  nav.restaurarGruposNav();
  assert.strictEqual(env.elementos.get('navsec-diadia').hidden, false, 'una preferencia guardada plegó Día a día');
  // ...ni llamando al plegado a mano (y sin guardar nada por intentarlo).
  const antes = env.localStorage.getItem('xaborNavGrupos');
  nav.toggleGrupoNav('diadia');
  assert.strictEqual(env.elementos.get('navsec-diadia').hidden, false, 'toggleGrupoNav plegó Día a día');
  assert.strictEqual(env.localStorage.getItem('xaborNavGrupos'), antes,
    'se guardó una preferencia para una sección que no se pliega');
  assert.ok(!/toggleGrupoNav\('diadia'\)/.test(NAV), 'el marcado ofrece plegar Día a día');
});

// El orden es el del plan acordado: lo de todos los días arriba y completo,
// después el negocio, después el dinero, y Configuración al pie.
t('18. el menú queda en el orden acordado, con los nombres nuevos', () => {
  const orden = DESTINOS_ESPERADOS.estructura;
  assert.deepStrictEqual(Object.keys(SECCIONES), Object.keys(orden.secciones), 'cambiaron las secciones o su orden');
  for (const [clave, tabs] of Object.entries(orden.secciones)) {
    assert.deepStrictEqual(SECCIONES[clave], tabs, `la sección ${clave} no tiene el orden acordado`);
  }
  assert.deepStrictEqual(PIE, orden.pie);
  const rotulo = (id) => (NAV.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)<\\/(?:button|div)>`)) || [, ''])[1]
    .replace(/<[^>]*>[^<]*<\/span>|<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  for (const [id, texto] of Object.entries(orden.rotulos)) {
    assert.strictEqual(rotulo(id), texto, `${id} se llama "${rotulo(id)}"`);
  }
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
