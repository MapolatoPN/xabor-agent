// Pantalla de entrada y pedido de prueba del panel.
//
// Desde la reorganización del menú, /app abre Inicio (no Pedidos), cada
// pantalla tiene una dirección legible (/app#pedidos, #caja...) que sobrevive
// a una recarga, y el pedido de prueba dejó el encabezado -- donde estaba a un
// clic de crear un pedido REAL -- para vivir en Configuración → Equipos e
// impresión, con confirmación.
//
// Lo que esta suite protege:
//   · que la computadora del negocio pueda quedarse fija en el tablero
//     (/app#pedidos) aunque /app abra Inicio,
//   · que una dirección no abra pantallas que el menú de ese usuario no
//     muestra (operador que teclea #caja),
//   · que el pedido de prueba no se dispare sin confirmación.
//
// Sin navegador ni backend: ejecuta las funciones REALES del panel contra un
// DOM mínimo (mismo método que fase-sidebar-plegable).
import { readFileSync } from 'fs';
import assert from 'assert';

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NAV = (html.match(/<div id="tabs-nav">([\s\S]*?)\n<\/div>\n\n<main[^>]*>/) || [])[1];
assert.ok(NAV, 'no se encontró el bloque #tabs-nav');

// ─── Funciones reales de navegación ─────────────────────────────────────────
const bloque = html.match(/const NAV_GRUPOS = [\s\S]*?\nfunction mostrarTab\(tab\) \{/);
assert.ok(bloque, 'no se encontró el bloque de navegación');
const FUENTE_NAV = bloque[0].replace(/\nfunction mostrarTab\(tab\) \{$/, '');
// Facturación guarda su sub-pantalla en la dirección (#facturacion/clientes):
// se usa la función real que la lee.
const FUENTE_PANE = (html.match(/function facturacionPaneDesdeHash\(\) \{[\s\S]*?\n\}\n/) || [])[0];
assert.ok(FUENTE_PANE, 'no se encontró facturacionPaneDesdeHash');

// visibles/ocultos: ids que existen en el DOM (los demás no existen).
function cargarNav({ visibles = [], ocultos = [], pathname = '/app', search = '', historia = null } = {}) {
  const el = (display) => ({ style: { display } });
  const document = {
    getElementById: (id) => (visibles.includes(id) ? el('') : ocultos.includes(id) ? el('none') : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const history = historia || { llamadas: [], replaceState(...args) { this.llamadas.push(args); } };
  const location = { pathname, search, hash: '' };
  const abiertas = [];                       // lo que se abrió con bnavTab
  const avisos = [];                         // lo que se le avisó al usuario
  const subpantallas = [];                   // sub-pantallas de Facturación pedidas
  const fabrica = new Function('document', 'localStorage', 'window', 'history', 'location', 'bnavTab', 'avisoPanel', 'facturacionIr', `
    ${FUENTE_NAV}
    ${FUENTE_PANE}
    return { navTabInicial, navTabDisponible, navEscribirRuta, navSeguirDireccion, navDireccionSinAcceso, navPestanaDeEntrada, NAV_RUTA_DE_TAB, NAV_TAB_DE_RUTA, NAV_PADRE_DE_TAB };
  `);
  const api = fabrica(document, { getItem: () => null, setItem() {} }, {}, history, location,
    (tab) => abiertas.push(tab), (texto) => avisos.push(texto), (pane) => subpantallas.push(pane));
  return { ...api, history, location, abiertas, avisos, subpantallas };
}

// ─── A. Entrar por /app abre Inicio ─────────────────────────────────────────
await t('A1. el marcado arranca en Inicio (no en Pedidos)', () => {
  assert.match(NAV, /<button class="tab-btn[^"]*\bactivo\b[^"]*" id="tab-inicio"/, 'Inicio no es el destino marcado de entrada');
  assert.ok(!/class="tab-btn[^"]*\bactivo\b[^"]*" id="tab-comandas"/.test(NAV), 'Pedidos sigue marcado de entrada');
  assert.strictEqual((NAV.match(/class="tab-btn[^"]*\bactivo\b/g) || []).length, 1, 'hay más de un destino marcado');
});

await t('A2. antes de la sesión solo se ve Inicio: nada de tablero parpadeando', () => {
  assert.match(html, /\n<main style="display:none;">\n/, 'el tablero (main) se ve antes de que cargue la sesión');
  assert.match(html, /\n<div id="vistas-extra">\n/, 'el contenedor de Inicio arranca oculto');
  const extra = html.slice(html.indexOf('\n<div id="vistas-extra">'), html.indexOf('</div><!-- /vistas-extra -->'));
  const vistas = [...extra.matchAll(/<div id="(vista-[a-z]+)"([^>]*)>/g)];
  assert.ok(vistas.length >= 15, `se esperaban las vistas del panel, hay ${vistas.length}`);
  const visibles = vistas.filter(v => !/display:\s*none/.test(v[2])).map(v => v[1]);
  assert.deepStrictEqual(visibles, ['vista-inicio'], `vistas visibles de entrada: ${visibles.join(', ')}`);
  assert.ok(!/class="bnav-item activo"/.test(html), 'la barra inferior del móvil marca una pantalla que no es la de entrada');
});

await t('A3. la pantalla de entrada se decide DESPUÉS de aplicar permisos', () => {
  const flujo = html.slice(html.indexOf("fetch('/api/auth/me'"));
  const iAdmin = flujo.indexOf(".admin-only').forEach");
  const iModulos = flujo.indexOf('aplicarModulosUI();');
  const iPlegado = flujo.indexOf('restaurarGruposNav();');
  const iEntrada = flujo.indexOf('bnavTab(navTabInicial(location.hash));');
  assert.ok(iEntrada > 0, 'el flujo de sesión ya no elige la pantalla de entrada con navTabInicial');
  assert.ok(iAdmin > 0 && iModulos > iAdmin && iPlegado > iModulos && iEntrada > iPlegado,
    'la pantalla de entrada se elige antes de saber qué puede ver este usuario');
  // El aviso de "sin acceso" se calcula con la dirección ORIGINAL: al entrar,
  // mostrarTab la reescribe con la pantalla real y el aviso se perdería.
  const iSinAcceso = flujo.indexOf('const entradaSinAcceso = navDireccionSinAcceso(location.hash);');
  const iAviso = flujo.indexOf("if (entradaSinAcceso) avisoPanel('No tienes acceso a esta sección', { error: true });");
  assert.ok(iSinAcceso > iPlegado && iSinAcceso < iEntrada && iAviso > iEntrada,
    'el aviso de "No tienes acceso a esta sección" se decide con la dirección ya reescrita');
});

// ─── B. Direcciones ─────────────────────────────────────────────────────────
await t('B1. sin dirección, o con una desconocida, entra a Inicio', () => {
  const nav = cargarNav({ visibles: ['tab-inicio', 'tab-comandas', 'tab-corte'] });
  for (const hash of ['', '#', '#nada', '#comandas', '#corte', '#PEDIDOS', '#%E0%A4%A']) {
    assert.strictEqual(nav.navTabInicial(hash), 'inicio', `"${hash}" no cayó en Inicio`);
  }
});

await t('B2. #pedidos abre el tablero (el marcador de la computadora del negocio)', () => {
  const nav = cargarNav({ visibles: ['tab-inicio', 'tab-comandas'] });
  assert.strictEqual(nav.navTabInicial('#pedidos'), 'comandas');
  assert.strictEqual(nav.navTabInicial('pedidos'), 'comandas', 'sin # también debe servir');
});

await t('B3. una dirección no abre lo que el menú de ese usuario no muestra', () => {
  // Operador: solo Pedidos y Mesas; Inicio, Caja, Chats y Configuración son
  // admin-only (regla del dueño, 2026-09-24).
  const operador = cargarNav({ visibles: ['tab-comandas', 'tab-restaurante'], ocultos: ['tab-inicio', 'tab-corte', 'tab-chats', 'tab-config', 'cfg-card-usuarios'] });
  for (const hash of ['#caja', '#configuracion', '#usuarios', '#chats', '#inicio']) {
    assert.strictEqual(operador.navTabInicial(hash), 'comandas', `${hash} no dejó al operador en Pedidos`);
  }
  // Negocio sin POS: #pedidos no puede abrir un tablero que no tiene.
  const sinPos = cargarNav({ visibles: ['tab-inicio'], ocultos: ['tab-comandas'] });
  assert.strictEqual(sinPos.navTabInicial('#pedidos'), 'inicio');
});

await t('B11. el operador entra a Pedidos, y a una sección ajena se le avisa', () => {
  const operador = cargarNav({ visibles: ['tab-comandas', 'tab-restaurante'], ocultos: ['tab-inicio', 'tab-corte', 'tab-chats', 'tab-config', 'cfg-card-usuarios'] });
  assert.strictEqual(operador.navTabInicial(''), 'comandas', 'sin Inicio, el operador no entró al tablero');
  for (const hash of ['#caja', '#chats', '#configuracion', '#usuarios', '#inicio']) {
    assert.strictEqual(operador.navDireccionSinAcceso(hash), true, `${hash} no avisaría "No tienes acceso"`);
  }
  // Lo suyo, lo vacío o lo que no existe no es "sin acceso".
  for (const hash of ['', '#', '#pedidos', '#nada', '#%E0%A4%A']) {
    assert.strictEqual(operador.navDireccionSinAcceso(hash), false, `${hash} avisaría sin motivo`);
  }
  // El admin, con todo visible, nunca recibe el aviso.
  const admin = cargarNav({ visibles: ['tab-inicio', 'tab-comandas', 'tab-corte', 'tab-chats', 'tab-config', 'cfg-card-usuarios'] });
  assert.strictEqual(admin.navDireccionSinAcceso('#caja'), false);
});

await t('B4. las vistas que cuelgan de Configuración respetan los gates de su tarjeta', () => {
  const admin = cargarNav({ visibles: ['tab-inicio', 'tab-config', 'cfg-card-usuarios', 'cfg-card-diagnostico'] });
  assert.strictEqual(admin.navTabInicial('#usuarios'), 'usuarios');
  assert.strictEqual(admin.navTabInicial('#estado'), 'diagnostico');
  // Negocio sin módulo usuarios: la tarjeta está oculta, la dirección también.
  const sinModulo = cargarNav({ visibles: ['tab-inicio', 'tab-config', 'cfg-card-diagnostico'], ocultos: ['cfg-card-usuarios'] });
  assert.strictEqual(sinModulo.navTabInicial('#usuarios'), 'inicio');
});

await t('B5. cada destino del menú tiene una dirección, y no se repiten', () => {
  const nav = cargarNav();
  const destinos = [...NAV.matchAll(/onclick="mostrarTab\('([a-z]+)'\)"/g)].map(m => m[1]);
  // Control de lectura, no de contenido: desde la Fase 2 varias pantallas son
  // pestañas (sus direcciones se revisan abajo, vía NAV_PADRE_DE_TAB).
  assert.ok(destinos.length >= 10, `pocos destinos leídos del menú: ${destinos.length}`);
  for (const tab of [...destinos, ...Object.keys(nav.NAV_PADRE_DE_TAB)]) {
    assert.ok(nav.NAV_RUTA_DE_TAB[tab], `${tab} no tiene dirección`);
  }
  const rutas = Object.values(nav.NAV_RUTA_DE_TAB);
  assert.strictEqual(new Set(rutas).size, rutas.length, 'hay dos pantallas con la misma dirección');
  // Una pestaña lleva la sección delante: pedidos/historial.
  for (const ruta of rutas) assert.match(ruta, /^[a-z]+(?:\/[a-z]+)?$/, `dirección con caracteres raros: ${ruta}`);
});

await t('B6. la dirección sigue a la pantalla sin llenar el historial', () => {
  const nav = cargarNav({ pathname: '/app', search: '?v=1' });
  nav.navEscribirRuta('comandas');
  nav.navEscribirRuta('corte');
  nav.navEscribirRuta('inicio');
  nav.navEscribirRuta('presencial');   // captura: no tiene dirección
  assert.deepStrictEqual(nav.history.llamadas, [
    [null, '', '#pedidos'],
    [null, '', '#caja'],
    [null, '', '/app?v=1'],            // Inicio es /app a secas
  ]);
  // Sin history (o si revienta), navegar no se rompe.
  const roto = cargarNav({ historia: { replaceState() { throw new Error('bloqueado'); } } });
  roto.navEscribirRuta('comandas');
});

// Facturación (línea de Codex) trae su propia sub-pantalla en la dirección y
// una dirección vieja. Al juntarla con el menú, un solo camino las atiende.
await t('B12. Facturación entra por #facturacion, su sub-pantalla y la vieja #config/facturacion', () => {
  const admin = cargarNav({ visibles: ['tab-inicio', 'tab-facturacion'] });
  for (const hash of ['#facturacion', '#facturacion/clientes', '#facturacion/configuracion', '#config/facturacion', '#config/facturacion/clientes']) {
    assert.strictEqual(admin.navTabInicial(hash), 'facturacion', `${hash} no abrió Facturación`);
  }
  // Parecidas que NO son Facturación.
  for (const hash of ['#facturacionx', '#configuracion/facturacion', '#x/facturacion']) {
    assert.strictEqual(admin.navTabInicial(hash), 'inicio', `${hash} abrió Facturación`);
  }
  // Sin el módulo, o para el operador, el botón está oculto: no entra y se le avisa.
  const sinAcceso = cargarNav({ visibles: ['tab-inicio'], ocultos: ['tab-facturacion'] });
  assert.strictEqual(sinAcceso.navTabInicial('#facturacion/clientes'), 'inicio');
  assert.strictEqual(sinAcceso.navDireccionSinAcceso('#facturacion/clientes'), true);
});

await t('B13. entrar a Facturación no borra la sub-pantalla que ya trae la dirección', () => {
  const nav = cargarNav();
  nav.location.hash = '#facturacion/clientes';
  nav.navEscribirRuta('facturacion');
  assert.deepStrictEqual(nav.history.llamadas, [], 'se pisó #facturacion/clientes con #facturacion');
  nav.location.hash = '#ventas';
  nav.navEscribirRuta('facturacion');
  assert.deepStrictEqual(nav.history.llamadas, [[null, '', '#facturacion']]);
});

await t('B14. con Facturación abierta, cambiar la sub-pantalla en la dirección no reabre la pantalla', () => {
  const nav = cargarNav({ visibles: ['tab-inicio', 'tab-facturacion'] });
  nav.navEscribirRuta('facturacion');
  nav.location.hash = '#facturacion/configuracion';
  nav.navSeguirDireccion();
  assert.deepStrictEqual(nav.abiertas, [], 'reabrió Facturación completa en vez de cambiar la sub-pantalla');
  assert.deepStrictEqual(nav.subpantallas, ['configuracion']);
  // Desde otra pantalla, la misma dirección sí abre Facturación.
  nav.navEscribirRuta('ventas');
  nav.location.hash = '#facturacion/clientes';
  nav.navSeguirDireccion();
  assert.deepStrictEqual(nav.abiertas, ['facturacion']);
});

await t('B15. el operador que teclea #facturacion recibe el aviso y se queda en Pedidos', () => {
  const operador = cargarNav({ visibles: ['tab-comandas', 'tab-restaurante'], ocultos: ['tab-inicio', 'tab-facturacion', 'tab-config'] });
  operador.navEscribirRuta('comandas');
  operador.location.hash = '#facturacion/clientes';
  operador.navSeguirDireccion();
  assert.deepStrictEqual(operador.abiertas, [], 'al operador se le abrió Facturación');
  assert.deepStrictEqual(operador.subpantallas, []);
  assert.deepStrictEqual(operador.avisos, ['No tienes acceso a esta sección']);
  assert.deepStrictEqual(operador.history.llamadas.at(-1), [null, '', '#pedidos'], 'la barra no volvió a Pedidos');
});

await t('B16. un solo camino de direcciones: nada abre Facturación saltándose los permisos', () => {
  const escuchas = html.match(/addEventListener\('hashchange'/g) || [];
  assert.strictEqual(escuchas.length, 1, `hay ${escuchas.length} escuchas de hashchange; debe ser solo navSeguirDireccion`);
  assert.match(html, /window\.addEventListener\('hashchange', navSeguirDireccion\);/);
  assert.ok(!/hashFacturacion/.test(html), 'volvió la entrada especial a Facturación que no revisa el menú');
});

// Fase 2.1: Historial y Repartidores son pestañas de Pedidos.
await t('B17. las pestañas de Pedidos tienen su dirección, y las viejas siguen entrando', () => {
  const admin = cargarNav({ visibles: ['tab-inicio', 'tab-comandas', 'pest-repartidores', 'pest-historial'] });
  assert.strictEqual(admin.navTabInicial('#pedidos/historial'), 'historial');
  assert.strictEqual(admin.navTabInicial('#pedidos/domicilio'), 'repartidores');
  // Marcadores viejos: abren la misma pantalla...
  assert.strictEqual(admin.navTabInicial('#historial'), 'historial');
  assert.strictEqual(admin.navTabInicial('#repartidores'), 'repartidores');
  // ...y al entrar, la barra ya muestra la dirección nueva.
  admin.navEscribirRuta('historial');
  admin.navEscribirRuta('repartidores');
  assert.deepStrictEqual(admin.history.llamadas, [[null, '', '#pedidos/historial'], [null, '', '#pedidos/domicilio']]);
});

await t('B18. el operador no entra a Historial ni a Domicilio por dirección', () => {
  const operador = cargarNav({ visibles: ['tab-comandas', 'tab-restaurante', 'pest-comandas'], ocultos: ['tab-inicio', 'pest-repartidores', 'pest-historial'] });
  for (const hash of ['#pedidos/historial', '#pedidos/domicilio', '#historial', '#repartidores']) {
    assert.strictEqual(operador.navTabInicial(hash), 'comandas', `${hash} no dejó al operador en En curso`);
    assert.strictEqual(operador.navDireccionSinAcceso(hash), true, `${hash} no avisaría "No tienes acceso"`);
  }
});

// Fase 2.2: el Asistente es la pestaña Bot de Chats.
await t('B19. el Bot tiene su dirección (#chats/bot) y #asistente sigue entrando', () => {
  const admin = cargarNav({ visibles: ['tab-inicio', 'tab-chats', 'pest-chats', 'pest-entrenamiento'] });
  assert.strictEqual(admin.navTabInicial('#chats/bot'), 'entrenamiento');
  assert.strictEqual(admin.navTabInicial('#asistente'), 'entrenamiento');
  admin.navEscribirRuta('entrenamiento');
  assert.deepStrictEqual(admin.history.llamadas, [[null, '', '#chats/bot']]);
});

await t('B20. sin WhatsApp, el botón Chats abre el Bot (no una pantalla que no puede usar)', () => {
  const sinWhatsapp = cargarNav({ visibles: ['tab-inicio', 'tab-chats', 'pest-entrenamiento'], ocultos: ['pest-chats'] });
  assert.strictEqual(sinWhatsapp.navPestanaDeEntrada('chats'), 'entrenamiento');
  assert.strictEqual(sinWhatsapp.navTabInicial('#chats/bot'), 'entrenamiento');
  // #chats es la sección, no una pantalla ajena: entra (y mostrarTab la lleva al Bot).
  assert.strictEqual(sinWhatsapp.navDireccionSinAcceso('#chats'), false, '#chats sin WhatsApp avisaría "sin acceso"');
  assert.strictEqual(sinWhatsapp.navTabInicial('#chats'), 'chats');
  // Con WhatsApp, Chats abre Conversaciones; fuera de una sección no cambia nada.
  const conWhatsapp = cargarNav({ visibles: ['tab-chats', 'pest-chats', 'pest-entrenamiento'] });
  assert.strictEqual(conWhatsapp.navPestanaDeEntrada('chats'), 'chats');
  assert.strictEqual(conWhatsapp.navPestanaDeEntrada('corte'), 'corte');
});

// Fase 2.3: Rewards y Campañas son pestañas de Clientes.
await t('B21. Rewards y Campañas tienen su dirección en Clientes, y #rewards sigue entrando', () => {
  const admin = cargarNav({ visibles: ['tab-inicio', 'tab-clientes', 'pest-clientes', 'pest-rewards', 'pest-campanas'] });
  assert.strictEqual(admin.navTabInicial('#clientes/rewards'), 'rewards');
  assert.strictEqual(admin.navTabInicial('#clientes/campanas'), 'campanas');
  assert.strictEqual(admin.navTabInicial('#rewards'), 'rewards');
  admin.navEscribirRuta('rewards');
  admin.navEscribirRuta('campanas');
  assert.deepStrictEqual(admin.history.llamadas, [[null, '', '#clientes/rewards'], [null, '', '#clientes/campanas']]);
  // Sin el módulo de Rewards (o sin WhatsApp para Campañas) la dirección no entra.
  const sinModulos = cargarNav({ visibles: ['tab-inicio', 'tab-clientes', 'pest-clientes'], ocultos: ['pest-rewards', 'pest-campanas'] });
  assert.strictEqual(sinModulos.navTabInicial('#clientes/rewards'), 'inicio');
  assert.strictEqual(sinModulos.navDireccionSinAcceso('#clientes/campanas'), true);
});

// Fase 2.4: Ventas y Correcciones son pestañas de Reportes.
await t('B22. Reportes: #reportes y #reportes/correcciones; #ventas y #correcciones siguen entrando', () => {
  const admin = cargarNav({ visibles: ['tab-inicio', 'tab-ventas', 'pest-ventas', 'pest-ajustes'] });
  assert.strictEqual(admin.navTabInicial('#reportes'), 'ventas');
  assert.strictEqual(admin.navTabInicial('#reportes/correcciones'), 'ajustes');
  assert.strictEqual(admin.navTabInicial('#ventas'), 'ventas');
  assert.strictEqual(admin.navTabInicial('#correcciones'), 'ajustes');
  admin.navEscribirRuta('ventas');
  admin.navEscribirRuta('ajustes');
  assert.deepStrictEqual(admin.history.llamadas, [[null, '', '#reportes'], [null, '', '#reportes/correcciones']]);
  // Negocio con Caja y sin POS: Reportes abre Correcciones, no una pantalla vacía.
  const sinPos = cargarNav({ visibles: ['tab-inicio', 'tab-ventas', 'pest-ajustes'], ocultos: ['pest-ventas'] });
  assert.strictEqual(sinPos.navPestanaDeEntrada('ventas'), 'ajustes');
});

await t('B8. si la sesión caduca, el login regresa a la misma dirección', () => {
  const fuente = html.match(/function irALogin\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(fuente, 'no se encontró irALogin');
  const location = { pathname: '/app', hash: '#pedidos', href: '' };
  new Function('location', `${fuente[0]}; irALogin();`)(location);
  const redirect = new URL(location.href, 'https://xabor.mx').searchParams.get('redirect');
  assert.strictEqual(redirect, '/app#pedidos', `el login regresaría a ${redirect}, no al tablero`);
  // Y el login obedece ese redirect tal cual.
  const login = readFileSync(new URL('../panel/login-negocio.html', import.meta.url), 'utf8');
  assert.match(login, /const redirectUrl = new URLSearchParams\(location\.search\)\.get\('redirect'\) \|\| '\/app';/,
    'el login ya no toma el redirect de la URL');
});

await t('B9. con el panel abierto, cambiar la dirección a mano navega (con las mismas reglas)', () => {
  const nav = cargarNav({ visibles: ['tab-inicio', 'tab-comandas'], ocultos: ['tab-corte'] });
  nav.navEscribirRuta('inicio');                       // el usuario está en Inicio
  nav.history.llamadas.length = 0;
  nav.location.hash = '#pedidos';                      // marcador a /app#pedidos
  nav.navSeguirDireccion();
  assert.deepStrictEqual(nav.abiertas, ['comandas'], 'no abrió el tablero');
  // Una que este usuario no ve: no se mueve y la barra vuelve a su pantalla.
  nav.navEscribirRuta('comandas');
  nav.history.llamadas.length = 0;
  nav.location.hash = '#caja';
  nav.navSeguirDireccion();
  assert.deepStrictEqual(nav.abiertas, ['comandas'], 'abrió Caja a quien no la ve');
  assert.deepStrictEqual(nav.history.llamadas, [[null, '', '#pedidos']], 'la barra quedó diciendo #caja');
  assert.deepStrictEqual(nav.avisos, ['No tienes acceso a esta sección'], 'no se le avisó que no tiene acceso');
  // El "#" vacío de un enlace tampoco mueve a nadie (ni avisa nada).
  nav.location.hash = '';
  nav.navSeguirDireccion();
  assert.deepStrictEqual(nav.abiertas, ['comandas']);
  assert.strictEqual(nav.avisos.length, 1, 'un "#" vacío disparó el aviso de sin acceso');
  // Y la misma pantalla en la que ya está no se vuelve a abrir.
  nav.location.hash = '#pedidos';
  nav.navSeguirDireccion();
  assert.deepStrictEqual(nav.abiertas, ['comandas'], 'reabrió la pantalla en la que ya estaba');
});

await t('B10. el seguimiento de la dirección se engancha DESPUÉS de elegir la entrada', () => {
  const flujo = html.slice(html.indexOf("fetch('/api/auth/me'"));
  const iEntrada = flujo.indexOf('bnavTab(navTabInicial(location.hash));');
  const iEscucha = flujo.indexOf("window.addEventListener('hashchange', navSeguirDireccion);");
  assert.ok(iEscucha > iEntrada && iEntrada > 0, 'la dirección se sigue antes de conocer los permisos del usuario');
  assert.strictEqual(html.split("addEventListener('hashchange'").length - 1, 1, 'hay más de un escucha de hashchange');
});

await t('B7. mostrarTab escribe la dirección de la pantalla que abre', () => {
  const cuerpo = html.slice(html.indexOf('function mostrarTab(tab) {'), html.indexOf('\n}\n', html.indexOf('function mostrarTab(tab) {')));
  assert.match(cuerpo, /\n  navEscribirRuta\(tab\);\n/, 'mostrarTab ya no actualiza la dirección');
});

// ─── C. Pedido de prueba ────────────────────────────────────────────────────
await t('C1. el pedido de prueba ya no está en el encabezado', () => {
  const cabecera = html.match(/<header>([\s\S]*?)<\/header>/)[1].replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/pedidoPrueba|probarNotificaciones|\/test\/pedido|🧪/.test(cabecera), 'el encabezado sigue disparando pedidos de prueba');
  assert.ok(!/function pedidoPrueba\b/.test(html), 'quedó la función vieja pedidoPrueba (sin confirmación)');
});

await t('C2. vive en Configuración → Equipos e impresión, con los mismos permisos', () => {
  const ini = html.indexOf('<div class="cfg-sec" id="cfg-sec-equipos">');
  assert.ok(ini > 0, 'no se encontró la sección Equipos e impresión');
  const equipos = html.slice(ini, html.indexOf('<div class="cfg-sec"', ini + 1));
  const bloque = equipos.match(/<div id="cfg-probar-notificaciones"([^>]*)>([\s\S]*?)\n      <\/div>/);
  assert.ok(bloque, 'Equipos e impresión no tiene el bloque del pedido de prueba');
  assert.match(bloque[1], /class="admin-only"/, 'el bloque perdió admin-only');
  assert.match(bloque[1], /data-modulo="pos"/, 'el bloque perdió data-modulo="pos" (el servidor lo exige)');
  assert.match(bloque[2], /onclick="probarNotificaciones\(\)"[^>]*>Probar notificaciones<\/button>/, 'falta el botón "Probar notificaciones"');
  assert.ok(bloque[2].includes('Envía un pedido de prueba para verificar sonido, impresión y avisos'), 'falta el texto de ayuda');
});

// probarNotificaciones real, con confirm/apiFetch/document simulados.
function cargarPrueba({ confirma, respuesta, falla = false }) {
  const fuente = html.match(/async function probarNotificaciones\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(fuente, 'no se encontró probarNotificaciones');
  const registro = { confirmaciones: [], envios: [], botonDuranteEnvio: null };
  const boton = { disabled: false };
  const fb = { style: {}, textContent: '' };
  const document = { getElementById: (id) => (id === 'btn-probar-notificaciones' ? boton : id === 'cfg-probar-fb' ? fb : null) };
  const confirm = (texto) => { registro.confirmaciones.push(texto); return confirma; };
  const apiFetch = async (url, opts) => {
    registro.envios.push([url, opts]);
    registro.botonDuranteEnvio = boton.disabled;
    if (falla) throw new Error('sin red');
    return { ok: respuesta.ok, json: async () => respuesta.cuerpo };
  };
  const fn = new Function('document', 'confirm', 'apiFetch', `${fuente[0]}; return probarNotificaciones;`)(document, confirm, apiFetch);
  return { fn, registro, boton, fb };
}

await t('C3. sin confirmación no se crea nada', async () => {
  const p = cargarPrueba({ confirma: false, respuesta: { ok: true, cuerpo: {} } });
  await p.fn();
  assert.strictEqual(p.registro.confirmaciones.length, 1, 'no pidió confirmación');
  assert.deepStrictEqual(p.registro.envios, [], 'creó el pedido aunque el usuario dijo que no');
});

await t('C4. confirmado: un solo POST, botón bloqueado mientras viaja, y aviso con el folio', async () => {
  const p = cargarPrueba({ confirma: true, respuesta: { ok: true, cuerpo: { ok: true, pedido: { id: 'XAB-0901' } } } });
  await p.fn();
  assert.deepStrictEqual(p.registro.envios, [['/test/pedido', { method: 'POST' }]]);
  assert.strictEqual(p.registro.botonDuranteEnvio, true, 'el botón se podía volver a pulsar mientras se creaba el pedido');
  assert.strictEqual(p.boton.disabled, false, 'el botón quedó bloqueado');
  assert.ok(p.fb.textContent.includes('XAB-0901'), `el aviso no dice qué pedido se creó: ${p.fb.textContent}`);
  assert.match(p.registro.confirmaciones[0], /tablero/i, 'la confirmación no avisa que el pedido es real');
});

await t('C5. si el servidor lo rechaza o no hay red, lo dice y libera el botón', async () => {
  const rechazo = cargarPrueba({ confirma: true, respuesta: { ok: false, cuerpo: { error: 'Módulo no habilitado' } } });
  await rechazo.fn();
  assert.strictEqual(rechazo.fb.textContent, 'Módulo no habilitado');
  assert.strictEqual(rechazo.boton.disabled, false);
  const sinRed = cargarPrueba({ confirma: true, falla: true, respuesta: { ok: true, cuerpo: {} } });
  await sinRed.fn();
  assert.match(sinRed.fb.textContent, /conexión/i);
  assert.strictEqual(sinRed.boton.disabled, false);
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
