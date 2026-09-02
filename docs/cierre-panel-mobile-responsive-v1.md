# Cierre — Panel Mobile Responsive V1

## Qué se pedía

Auditar y dejar el panel de operación (`panel/index.html`) usable en móvil:
sin scroll horizontal, con la navegación, los formularios y los modales
utilizables desde un teléfono, **sin tocar lógica de negocio** (ni API, ni
base de datos, ni el motor de promociones, ni pricing, ni WhatsApp, ni POS,
ni `reglas_atencion`, ni migraciones) y **sin romper el escritorio**.

## Hallazgo principal

El panel **ya era responsivo**. La estructura mobile-first estaba puesta y
funcionando: barra lateral (`#tabs-nav`) que en ≤640px se cambia por una
barra inferior (`#bottom-nav`) más un cajón "Más" (`#mas-sheet`), header
compacto, comandas y POS a una columna, formularios de Tienda/Promociones
que colapsan a una columna (`.tnd-fila > * { min-width:100% }`), y modales
que caben en 375px.

La auditoría se corrió en el navegador embebido a **375, 390, 430, 360,
768 y 1425px**, recorriendo las 17 pestañas, los modales, el formulario de
Promociones (incluido el editor de condiciones), Impresoras y Rutas.

**Resultado:** overflow horizontal = 0 en todas las pantallas y viewports,
**salvo un único punto**.

## Único arreglo aplicado

Las sub-pestañas de Rewards (`#rw-subtabs`, 4 pestañas de `padding:9px 18px`)
desbordaban ~24px en pantallas angostas. Se contuvo el desbordamiento
**dentro de la barra** (scroll horizontal propio, sin barra visible), nunca
en la página — mismo patrón que `.chats-filtros`:

```css
#rw-subtabs { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
#rw-subtabs::-webkit-scrollbar { display: none; }
#rw-subtabs .rw-stab { flex-shrink: 0; white-space: nowrap; }
```

En escritorio las 4 pestañas caben sin scroll, así que la regla es un no-op
allí: **cero regresión** (verificado a 1425px — barra lateral visible,
overflow de página = 0, `#rw-subtabs` sin scroll interno; filas de 2 campos
como Compra/Beneficia y fechas siguen en 2 columnas).

Es el **único** cambio de código del sprint: `panel/index.html`, +7 líneas,
exclusivamente CSS. No se tocó una sola línea de JS, lógica ni datos.

## Guardián contra regresión

`test/fase-panel-responsive.mjs` (nuevo) lee el HTML servido y comprueba los
invariantes que mantienen el panel usable en móvil: viewport adaptable,
margen de escritorio para la barra lateral, swap sidebar↔barra inferior en
≤640px, barra inferior oculta por defecto, existencia de la barra inferior /
cajón "Más" / fondo, manejadores `abrirMasSheet`/`cerrarMasSheet`, colapso
de `.tnd-fila` a una columna, el fix de `#rw-subtabs`, y que ni `body` ni
`main` fijen un ancho mínimo que reintroduzca scroll horizontal. Es un
guardián estructural ligero (sin navegador ni servidor); la verificación
fina es visual y multi-viewport.

## Regla de desarrollo hacia adelante

> **Toda nueva función del panel Xabor debe validarse en escritorio y en
> móvil antes de considerarse terminada.** El panel es una sola página que
> sirve por igual a la caja de escritorio y al teléfono del dueño; una
> pantalla o un formulario nuevo no está terminado hasta comprobarse a
> ~375px (sin scroll horizontal, controles alcanzables) además de en
> escritorio. Cuando se agregue una fila de pestañas, una tabla o un
> formulario, reutilizar los patrones ya existentes (`.tnd-fila`,
> `overflow-x:auto` acotado como en `#rw-subtabs`/`.chats-filtros`, colapso a
> una columna en `@media (max-width:640px)`) en vez de anchos fijos.

## Bugs funcionales

Ninguno detectado durante la auditoría. La auditoría fue exclusivamente de
UI/UX; de haber aparecido un bug funcional se habría reportado por separado,
no corregido en silencio.
