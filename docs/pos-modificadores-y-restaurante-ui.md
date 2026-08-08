# Restaurante en el panel + modificadores de menú en POS

Rama `fix/mapolato-restaurante-ui-pos-modificadores` (base b8c8a08, el commit
desplegado). **Sin migración** — 041 sigue libre.

## Problema A — Restaurante no aparecía en el panel

**Causa:** la UI operativa **ya existía completa** (`panel/mesas.html`:
rejilla de mesas, abrir mesa, cuenta, items, comandas, cancelación auditada,
pagos, división, cierre, mover) y el backend la servía por `express.static`,
pero **ningún archivo la enlazaba**: `grep -r "mesas.html" panel/ src/` no
devolvía una sola coincidencia. Solo se llegaba escribiendo la URL a mano.
Por eso Superadmin mostraba el módulo activo y readiness LISTO mientras el
negocio no veía Restaurante por ningún lado.

Clasificación: **caso A — existe completa, no estaba enlazada.**

**Corrección:** una pestaña más en `panel/index.html`, con el patrón que ya
usan las demás:

```html
<button class="tab-btn" id="tab-restaurante" data-modulo="restaurante"
        onclick="location.href='/mesas.html'">Restaurante</button>
```

`aplicarModulosUI()` oculta cualquier `[data-modulo]` que el negocio no
tenga, y el backend sigue respondiendo 403 en `requireModulo('restaurante')`
—la UI es comodidad, el candado real es del servidor—. Mesas y meseros
siguen igual: las mesas se generan desde `configuracion.restaurante_num_mesas`
(default 12, sin tabla nueva) y el mesero son los **usuarios activos del
negocio** (`abrirMesa` rechaza un usuario de otro negocio). No se creó rol
"mesero" ni CRUD duplicado.

## Problema B — el POS ignoraba los modificadores

**Causa:** el modelo existía (`menu_modificadores_grupos` /
`menu_modificadores_opciones`) y `obtenerMenuCompleto` **ya los devolvía** en
`GET /api/menu`, pero el POS pintaba el producto con
`agregarAlCarrito({nombre, precio})` y descartaba el resto. Además
`recalcularItemsDesdeMenu` aceptaba un arreglo `extras` **con el precio que
mandara el frontend**: se podía cobrar "Bistec en Salsa" con `precio_extra: 0`.

Clasificación: **el backend ya los exponía (caso A) pero no los validaba** —
había que arreglar el frontend *y* cerrar el hueco de precio.

**Corrección:** `src/services/modificadores.js`, única fuente de verdad:

- recibe **solo ids de opción**; nombres, precios extra, pertenencia al
  producto, disponibilidad y reglas de grupo salen de la base del negocio;
- valida requerido / mínimo / máximo, opción inexistente, de otro grupo, de
  otro producto, de otro tenant, no disponible y duplicada, con errores
  tipados que las rutas traducen a **400** (nunca 500);
- devuelve el snapshot (`grupo`, `opcion`, `precio_extra`) y el texto para
  comanda (`Salsas: Verde · Proteína: Bistec en Salsa`).

Lo usan los tres caminos, sin implementaciones divergentes:

| Camino | Ruta | Qué cambia |
|---|---|---|
| POS Envíos | `POST /api/pos/pedidos` | `recalcularItemsDesdeMenu` valida y cobra desde la base |
| POS presencial | `POST /api/pedido-presencial` | items con `producto_id` se resuelven en el servidor; si **todo** el pedido viene del menú, el **total también lo fija el servidor** |
| Restaurante | `POST /api/restaurante/cuentas/:id/items` | acepta `producto_id` + `modificadores` y resuelve igual; el item libre (producto + precio) sigue existiendo para lo que no está en el menú |

Precio: `precio base real + extras reales`, por cantidad
(195 + 30 = 225; ×2 = 450), redondeado a dos decimales como el resto del
sistema.

**Frontend:** `panel/modificadores.js` es un modal compartido por POS y
Mesas (una sola implementación). Radio si el grupo admite 1, checkbox si
admite más, bloqueo al llegar al máximo, extras visibles, contador de
cantidad y botón deshabilitado hasta cumplir lo requerido. El carrito del POS
separa líneas por **producto + selección**: dos Chilaquiles con
combinaciones distintas son dos líneas; solo se fusiona la cantidad si la
selección es idéntica.

## Snapshot, comanda y ticket

El item persistido guarda `modificadores` (con su precio) y el texto en
`notas`. Comanda, ticket e historial ya renderizan `item.notas`, así que la
cocina ve la selección sin tocar la capa de impresión — y el pedido de ayer
conserva lo elegido aunque el menú cambie mañana.

## Lo que NO cambió

Motor de pedidos (P0 de folios), arranque (`arrancar()` / `server.listen`),
`restauranteService`, pagos, Clip, Meta/WhatsApp, Rappi, repartidores,
Superadmin y el esquema de base de datos. El camino de item libre del POS
presencial (sin `producto_id`) conserva su precio manual de siempre: es para
lo que no está en el menú y lo captura un usuario ya autenticado de ese
negocio.

## Pruebas

`test/fase-pos-modificadores-restaurante-ui.mjs` (28 casos) + regresión
completa (21 suites) + POS 5 veces + esta suite 3 veces + build Docker.
