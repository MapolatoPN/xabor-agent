# Cierre — Paridad de navegación móvil ↔ desktop

## Qué se pedía

El sprint "Panel Mobile Responsive V1" dejó el panel bien adaptado
visualmente, pero el smoke real en iPhone reveló otro problema: la
**navegación móvil no tenía paridad funcional con desktop**. En el drawer
"Más" faltaban módulos que el negocio SÍ tenía habilitados (Promociones el
más visible). Objetivo: que móvil exponga todos los módulos habilitados que
corresponden a la navegación desktop, con los mismos gates, y **eliminar la
posibilidad de que vuelvan a desincronizarse**. Sin tocar backend, base de
datos, migraciones, PromotionEngine, pricing, pedidos, WhatsApp, impresión,
routing ni permisos reales — solo navegación/presentación.

## Causa raíz

El drawer móvil `#mas-sheet` era una **lista de módulos escrita a mano**
(8 `<button class="mas-item">` con su propio `onclick` y su propio
`data-modulo`), completamente independiente del sidebar de escritorio
`#tabs-nav`. Dos listas paralelas ⇒ deriva inevitable: cada módulo nuevo se
agregaba al sidebar y se olvidaba en el drawer.

Además, "Promociones" no es un tab propio: vive como sub-pestaña dentro de
**Catálogo → Tienda en línea** (`#tab-tienda`, que `aplicarModulosUI`
renombra a "Promociones" cuando el negocio tiene `menu`/`pos` pero no
`tienda_online`). El drawer hecho a mano nunca incluyó `#tab-tienda`, así
que Promociones era inalcanzable en móvil.

## Módulos que estaban ausentes en móvil (antes)

Presentes en desktop, ausentes en el drawer: **Inicio, Restaurante,
Tienda en línea/Promociones, Rewards, Cotizaciones, Asistente, Ventas,
Ajustes, Estado**. El drawer solo tenía: Historial, Ventas(¡no!—en realidad
solo)… la lista real hardcodeada era Historial, Ventas, Llamadas, Menú,
Config, Repartidores, Clientes, Usuarios.

## Arquitectura elegida — fuente única de navegación

Se hace del **sidebar `#tabs-nav` la fuente única** de navegación. El drawer
ya no tiene lista propia: se **genera** en `construirDrawerMovil()` a partir
del sidebar, invocado en el flujo de auth **después** de aplicar los gates
(`admin-only` + `aplicarModulosUI()`), tomando cada `.tab-btn` que quedó
visible y que no vive ya en la barra inferior, con su **misma etiqueta**
(hereda el relabel "Tienda en línea"→"Promociones") y su **misma acción**
(el `click()` del propio botón del sidebar). Se preservan los grupos del
sidebar como encabezados (Operación, Catálogo, Clientes, Automatización,
Administración, Configuración).

Consecuencia — el invariante que pedía el sprint: **agregar un módulo al
sidebar lo hace aparecer en móvil automáticamente; es imposible que vuelvan
a desincronizarse**, porque el drawer no puede saber de un módulo que el
sidebar no tenga.

### Por qué derivar del DOM del sidebar y no un `NAV_ITEMS` nuevo

La preferencia declarada era un `NAV_ITEMS` central del que deriven ambos.
Reescribir el sidebar de escritorio (HTML estático con agrupación, aria y
comentarios, ya probado por `fase-sidebar-plegable.mjs`) para generarlo desde
un array era un cambio grande y arriesgado sobre algo que funciona, y el
sprint pedía explícitamente **no** rehacer lo que ya sirve. Reutilizar el
sidebar ya gateado COMO esa definición central cumple el mismo objetivo
(cero duplicación de módulos, cero duplicación de permisos, una sola
definición de acción) con superficie mínima. Se documenta como decisión
consciente.

## Gates verificados (sin duplicar lógica)

El drawer **no re-evalúa** módulos ni rol: hereda la visibilidad ya resuelta
por `aplicarModulosUI()` (`data-modulo`, `data-modulo-any`) y por el ocultado
de `.admin-only`. Verificado en smoke real:

- Negocio con `tienda_online`/`menu`/`pos` → aparece Tienda/Promociones.
- Sin `rewards`/`voz`/`usuarios` → no aparecen Rewards/Llamadas/Usuarios.
- Rol operador (no admin) → no ve entradas `admin-only` (p. ej. Historial).
- `data-modulo-any="tienda_online,menu,pos"` respetado para Promociones.
- Sin hardcodear ningún negocio (Nonna/Mapolato).

## Tabla desktop vs móvil (después)

| Módulo | Desktop | Barra inferior | Drawer "Más" | Gate |
|---|---|---|---|---|
| Pedidos/Comandas | ✓ | ✓ (Comandas) | — (ya en barra) | pos |
| Nuevo pedido | ✓ | ✓ (Nuevo) | — (acción) | pos |
| Chats | ✓ | ✓ (Chats) | — (ya en barra) | whatsapp |
| Corte | ✓ | ✓ (Corte) | — (ya en barra) | caja |
| Inicio | ✓ | — | ✓ | — |
| Restaurante | ✓ | — | ✓ (si habilitado) | restaurante |
| Historial | ✓ | — | ✓ | pos + admin |
| Repartidores | ✓ | — | ✓ | pos + admin |
| Menú | ✓ | — | ✓ | menu + admin |
| Tienda en línea / **Promociones** | ✓ | — | ✓ | tienda_online\|menu\|pos + admin |
| Clientes | ✓ | — | ✓ | admin |
| Rewards | ✓ | — | ✓ | rewards + admin |
| Cotizaciones | ✓ | — | ✓ | cotizaciones + admin |
| Asistente | ✓ | — | ✓ | admin |
| Llamadas | ✓ | — | ✓ | voz |
| Ventas | ✓ | — | ✓ | pos + admin |
| Ajustes | ✓ | — | ✓ | caja + admin |
| Usuarios | ✓ | — | ✓ | usuarios + admin |
| Configuración | ✓ | — | ✓ | admin |
| Estado | ✓ | — | ✓ | admin |

Barra inferior sin cambios: Comandas · Nuevo · Chats · Corte · Más.

## Archivos modificados

- `panel/index.html` — CSS del drawer (`overflow-y:auto` + `.mas-grupo`);
  `#mas-sheet` deja de tener lista fija y pasa a `#mas-lista` (contenedor
  generado); `construirDrawerMovil()` + `NAV_ICONOS` + `DRAWER_EXCLUIR`; una
  llamada a `construirDrawerMovil()` tras `aplicarModulosUI()`. Nada más.
- `test/fase-paridad-navegacion-movil.mjs` — nuevo. Ejecuta las funciones
  reales contra un DOM mínimo armado del markup real; 9 casos incluyendo el
  invariante de no-regresión y el caso de aceptación de Promociones.

## Regla de desarrollo (se mantiene y se refuerza)

> El sidebar `#tabs-nav` es la **fuente única** de navegación del panel. La
> navegación móvil se **deriva** de él (no se mantiene aparte). Cualquier
> módulo nuevo se agrega al sidebar con su gate; móvil lo hereda solo. Toda
> función nueva del panel se valida en escritorio **y** móvil antes de darse
> por terminada (ver docs/cierre-panel-mobile-responsive-v1.md).

## Regresiones

Ninguna nueva. Desktop 1440 sin cambios (sidebar visible, barra inferior
oculta, formularios de dos columnas intactos, overflow 0). Suites
`fase-panel-responsive` (9/9) y `fase-paridad-navegacion-movil` (9/9) verdes.

Nota: `fase-sidebar-plegable.mjs` falla en su caso 16 **de forma
preexistente** — falla idéntica contra el panel ya commiteado en HEAD, sin
mis cambios (confirmado con `git stash`). No es de este sprint; queda para
revisión aparte.

## Smoke real (local, sesión admin de Nonna en pg-noche)

- 390px: drawer expone los 15 destinos habilitados, agrupados y con iconos;
  **Más → Tienda en línea** cierra el drawer y abre la misma vista; la
  sub-pestaña Promociones se muestra y "+ Nueva promoción" abre el form
  completo (48 controles) sin overflow; Config/Menú/Clientes abren; sin
  recorte de texto (todo cabe en 260px); overflow de página 0.
- 430px: overflow 0, barra inferior visible, sidebar oculto.
- Desktop 1440: sidebar normal, barra inferior oculta, drawer no intrusivo,
  fila de dos campos en 2 columnas, overflow 0.
