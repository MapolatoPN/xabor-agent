// El panel se mantiene usable en móvil.
//
// Esto existe porque el panel (panel/index.html) es una sola página con
// todo el CSS y el JS embebidos, y ya sirve tanto a la operación de
// escritorio como al teléfono del negocio. La responsividad no vive en un
// framework: vive en un puñado de reglas frágiles (el swap de barra lateral
// por barra inferior, el cajón "Más", el colapso de formularios a una
// columna) que una edición descuidada del archivo gigante puede borrar sin
// que nadie lo note hasta que un dueño abre el panel desde su celular.
//
// La prueba NO abre un navegador ni levanta un servidor: lee el archivo
// servido tal cual y comprueba que esos invariantes siguen presentes. Es un
// guardián estructural, deliberadamente ligero — si mañana alguien quita el
// #bottom-nav o el breakpoint de 640px, aquí se rompe antes de llegar a
// producción. La verificación fina (que de verdad se vea bien) es la
// auditoría visual multi-viewport documentada en
// docs/cierre-panel-mobile-responsive-v1.md; esto solo evita la regresión
// silenciosa de la estructura.
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dir, '..', 'panel', 'index.html'), 'utf8');
// CSS multilínea: se aplana a un solo espacio para poder buscar reglas que
// abarcan varias líneas sin depender del formato exacto.
const plano = html.replace(/\s+/g, ' ');

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(cat, nombre, fn) {
  try { fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ── 1. La página se declara adaptable al ancho del dispositivo ─────────────
t('BASE', '1. el viewport se ajusta al ancho del dispositivo', () => {
  const m = html.match(/<meta\s+name="viewport"[^>]*>/i);
  assert.ok(m, 'falta la etiqueta <meta name="viewport">');
  assert.match(m[0], /width=device-width/, 'el viewport no usa width=device-width');
});

// ── 2. En escritorio el contenido deja lugar a la barra lateral ────────────
t('DESKTOP', '2. en ≥641px el contenido se recorre para la barra lateral', () => {
  assert.match(plano, /@media screen and \(min-width: ?641px\) \{ main, #vistas-extra \{ margin-left: var\(--sidebar-w\)/,
    'se perdió el margen de escritorio que reserva la barra lateral');
});

// ── 3. En móvil la barra lateral se cambia por la barra inferior ───────────
t('MOBILE', '3. en ≤640px se oculta el sidebar y aparece la barra inferior', () => {
  // Dentro de un @media (max-width: 640px) deben convivir ambas reglas.
  const bloque = plano.match(/@media \(max-width: ?640px\) \{[^]*?#tabs-nav \{ display: none;[^]*?#bottom-nav \{ display: flex;/);
  assert.ok(bloque, 'en ≤640px ya no se oculta #tabs-nav y/o no se muestra #bottom-nav');
});

// ── 4. La barra inferior no invade el escritorio ───────────────────────────
t('DESKTOP', '4. la barra inferior nace oculta (solo móvil la muestra)', () => {
  assert.match(plano, /#bottom-nav \{ display: none ?!important/,
    'el #bottom-nav dejó de estar oculto por defecto: aparecería también en escritorio');
});

// ── 5. Los elementos de navegación móvil existen ───────────────────────────
t('MOBILE', '5. existen la barra inferior, el cajón "Más" y su fondo', () => {
  for (const id of ['bottom-nav', 'mas-sheet', 'mas-overlay']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `falta el elemento id="${id}" de la navegación móvil`);
  }
});

// ── 6. El cajón "Más" se abre y se cierra ──────────────────────────────────
t('MOBILE', '6. la navegación móvil tiene sus manejadores de abrir/cerrar', () => {
  assert.ok(/function abrirMasSheet\b/.test(html), 'falta abrirMasSheet(): el cajón "Más" no abriría');
  assert.ok(/function cerrarMasSheet\b/.test(html), 'falta cerrarMasSheet(): el cajón "Más" no cerraría');
});

// ── 7. Los formularios de Tienda colapsan a una columna en móvil ───────────
t('MOBILE', '7. las filas de formulario de Tienda/Promociones se apilan en ≤640px', () => {
  assert.match(plano, /@media \(max-width: ?640px\) \{ \.tnd-sec \{ max-width:100%; \} \.tnd-fila > \* \{ min-width:100%;/,
    'los campos de Promociones ya no se apilan a una columna en móvil');
});

// ── 8. La fila de sub-pestañas de Rewards no desborda la página ────────────
t('MOBILE', '8. las sub-pestañas de Rewards contienen su scroll (fix de la auditoría)', () => {
  assert.match(plano, /#rw-subtabs \{ overflow-x: auto;/,
    'se perdió el fix que evita el desbordamiento horizontal de las sub-pestañas de Rewards');
});

// ── 9. Nada fuerza un ancho fijo de escritorio ─────────────────────────────
t('BASE', '9. ni body ni main fijan un ancho mínimo que provoque scroll horizontal', () => {
  // Un min-width en píxeles sobre el contenedor de página reintroduciría el
  // scroll horizontal en móvil (el fallo que toda esta responsividad evita).
  for (const sel of ['body', 'main']) {
    const m = plano.match(new RegExp(`(?:^|[}\\s])${sel} \\{([^}]*)\\}`));
    if (m) {
      const px = m[1].match(/min-width: ?(\d+)px/);
      assert.ok(!(px && Number(px[1]) >= 700),
        `${sel} fija min-width:${px && px[1]}px — reintroduce scroll horizontal en móvil`);
    }
  }
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
