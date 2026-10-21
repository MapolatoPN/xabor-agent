# Configuración → Impresoras: equipos, rutas y papel de 48

Rama `feat/impresoras-equipos-rutas`, sobre `feat/formato-configurable`
(4bbe9d5). Fases 1 y 2 del plan de Impresoras. Lo que la pantalla no decía, y
que costó semanas de comandas sin papel en Acuña, ahora se ve y se arregla
desde el panel.

## Lo que cambia en la pantalla

**Cada equipo** (cada PC con Xabor Edge) dice:
- «Conectado ✓ · Xabor Edge 1.2.0». Si está conectado pero no dice versión, es
  un Edge anterior a la 1.2: «instálale la nueva una vez y después se
  actualiza sola»;
- «Sin conexión desde hace 3 días», con la fecha exacta al pasar el ratón;
- «Nunca se ha conectado» (los «fantasmas»: altas cuyo instalador nunca
  terminó).

**«Olvidar este equipo»**, solo en equipos sin conexión. Antes de confirmar
dice qué se pierde:
- qué impresoras dejan de usarse;
- qué categorías salían ahí y ahora saldrán en Cocina;
- cuántas impresiones que lo esperaban se cancelan.

**Papel**: además de 58 mm y 80 mm, «80 mm a todo lo ancho» (48 columnas, con
la comanda en letra más grande). Antes no se podía elegir, y «Guardar» con
80 mm regresaba a 42 una impresora puesta en 48 a mano. La ayuda explica cómo
saberlo con «Imprimir prueba»: la línea `1234567890…` tiene que caber en un
renglón.

**Rutas de preparación** ahora dicen qué se imprime dónde:
- «Todo lo demás (Cocina) → …» y «Ticket del cliente (Caja) → …»;
- cada ruta de categoría o de platillo, con el nombre como está en el menú;
- en amarillo, las que no funcionan:
  - «esa impresora está fuera de uso: esto sale en Cocina»;
  - «el equipo de esa impresora no está conectado: mientras tanto esto sale
    en Cocina» (mismo criterio que el reparto: socket vivo o señal en los
    últimos 2 minutos);
- cada ruta se cambia de impresora con su selector, sin borrarla y crearla
  otra vez. «Quitar» pide confirmación;
- al agregar, las categorías que ya tienen ruta lo dicen.

## Olvidar un equipo, por dentro

`src/services/equiposImpresion.js`. No borra filas: el historial de
impresiones se queda. En una transacción:
1. cancela lo que seguía esperando a ese equipo (`pendiente`, `entregado` sin
   confirmar y `fallido`), con motivo «Equipo olvidado desde el panel».
   `incierto` y `agotado` no se tocan: ya los revisa una persona;
2. borra las rutas de sus impresoras y las apaga;
3. apaga el equipo, le retira la credencial y anula un código de vinculación
   sin usar: aunque la PC volviera, ya no entra;
4. renombra equipo e impresoras («… (olvidado 2026-10-20 · 1a2b3c4d)»). Los
   nombres son únicos por sucursal: sin esto no se podría volver a dar de alta
   «caja» ni configurar una impresora del mismo modelo en la PC nueva;
5. lo registra en `auditoria_plataforma` (`olvidar_equipo_impresion`, con el
   administrador que lo hizo).

No se puede olvidar un equipo con el WebSocket abierto ni con señal en los
últimos 2 minutos: está imprimiendo.

**Para la PC de Acuña** con 70 comandas esperando desde octubre: olvidarla
desde el panel hace lo mismo que el script
`scripts/ops/impresion-sin-perdidas-2026-10/pendientes-viejos.mjs`, y además
la quita de la lista.

## API

Todo detrás de `requireAdminSeguro`; el negocio sale de la sesión.
- `GET /api/impresion/self-service`, ahora con:
  - por equipo: `nuncaConectado`, `version`, y `papel` por impresora;
  - `papeles`, `rutasPreparacion`, `porDefecto` e `impresorasParaRutas`.
- `POST /api/impresion/self-service/asignar` acepta `papel`: `'58'`, `'80'` u
  `'80-completo'`. `anchoMm` sigue funcionando.
- `GET /api/impresion/edges/:id/olvido`: qué se perdería.
- `POST /api/impresion/edges/:id/olvidar`: 409 si está conectado, 404 si no es
  del negocio.
- `PATCH /api/impresion/rutas/:id { impresoraId }`: la misma regla, otra
  impresora. Solo de este negocio, de la misma sucursal y en uso: 409 si
  está fuera de uso o la regla ya existe.

## Panel

Componente protegido: `index.html` cambia lo mínimo.
- `panel/impresorasEquipos.js` (`window.XaborImpresoras`) pinta el estado del
  equipo, el botón y el flujo de olvidar, la ayuda del papel y la sección de
  rutas.
- `index.html`:
  - lo carga con `?v=<huella>`;
  - lo llama desde `pintarImpresoras()` y `renderRutasPreparacion()`;
  - manda `papel` al guardar;
  - deja de pedir `/api/impresion/impresoras` y `/api/impresion/rutas` (ya
    vienen en `self-service`).
- De paso, dos mensajes que se pintaban con `textContent` y mostraban
  «qu&eacute;» y «est&aacute;» tal cual.

## Pruebas

`node test/fase-impresoras-equipos-rutas.mjs`: 21 de 21.
- **A (1–7), sin base:** el papel, el módulo del panel en un navegador
  mínimo, sin jerga a la vista, nombres escapados y la huella.
- **B (8–16), servicios con Postgres:**
  - estado de los equipos y de cada ruta;
  - cambiar rutas, con sus rechazos (apagada, otro negocio, otra sucursal,
    duplicada);
  - el papel de 48 tras «Guardar» e «Imprimir prueba»;
  - qué se pierde al olvidar y qué no se olvida (conectado, señal reciente,
    otro negocio);
  - el olvido completo, volver a dar de alta el mismo nombre e impresora, y
    que lo de esa estación sale en Cocina sin desvío.
- **C (17–20), servidor real:**
  - solo administradores;
  - la versión de un Edge conectado;
  - que un socket abierto impide olvidar aunque la última señal en la base
    sea vieja;
  - el olvido por HTTP con su auditoría, y rutas y papel por HTTP.
- **D (21), Chrome real:**
  - los tres estados de equipo;
  - elegir «80 mm a todo lo ancho», guardar y recargar;
  - cambiar una ruta y ver desaparecer el aviso;
  - olvidar un equipo leyendo el aviso;
  - en teléfono sin desbordar y sin errores de JavaScript.

Siguen verdes las suites de autoservicio, impresión, Edge, panel y
print-agent, y el predeploy. En `fase-impresion-autoservicio` cambió una
aserción: ahora exige el mensaje legible. `fase-c-bot-global` falla igual
(11 casos) en el commit base: es de los datos locales.

**Mordidas:** las 46, desactivadas una por una, tumban al menos un caso. Si
la mordida toca `panel/impresorasEquipos.js`, el corredor pone la huella al
día en `index.html`, como un despliegue correcto, para que no muerda solo por
la huella. «Huella vieja» es la mordida aparte.

| Se desactiva | Casos que caen |
|---|---|
| existe «80 mm a todo lo ancho» | 1, 8, 11, 20, 21 |
| una impresora en 48 se reconoce como tal | 1, 11, 16, 20, 21 |
| «Guardar» respeta el papel (servicio) | 11, 16, 20, 21 |
| «Guardar» respeta el papel (ruta HTTP) | 20, 21 |
| los olvidados no se muestran | 14, 19 |
| la pantalla recibe la versión | 18, 21 |
| se dice «nunca se conectó» | 8, 18, 21 |
| se marca la ruta a un equipo sin conexión | 9, 21 |
| se marca la ruta a una impresora apagada | 9 |
| no se ofrece una impresora fuera de uso | 9 |
| cambiar ruta: no a una apagada | 10, 12, 14, 20 |
| cambiar ruta: no a otra sucursal | 10, 12, 14 |
| cambiar ruta: no de otro negocio | 10, 12, 14 |
| cambiar ruta: solo administradores | 17, 20, 21 |
| olvidar: solo administradores | 17, 18, 19, 21 |
| olvidar: mira el socket | 18, 20, 21 |
| olvidar: revisa la conexión | 13, 16, 18, 20, 21 |
| olvidar: gracia de 2 minutos | 12, 13, 20 |
| olvidar: no cancela los inciertos | 12, 14 |
| olvidar: cancela lo que esperaba | 14 |
| olvidar: quita las rutas | 14 |
| olvidar: apaga las impresoras | 14 |
| olvidar: renombra impresoras | 14, 15 |
| olvidar: renombra el equipo | 14, 15 |
| olvidar: retira la credencial | 14 |
| olvidar: apaga el equipo | 14, 19, 21 |
| olvidar: anula el código de vinculación | 14 |
| olvidar: auditoría | 14, 19 |
| olvidar: solo equipos del negocio | 13, 14 |
| el resumen cuenta solo lo que espera | 12 |
| panel: no ofrece olvidar un conectado | 4, 21 |
| panel: olvidar pide confirmación | 7 |
| panel: no olvida un conectado | 7 |
| panel: avisos de rutas | 5, 21 |
| panel: quitar ruta pide confirmación | 6 |
| panel: compara categorías sin acentos ni mayúsculas | 5 |
| panel: escapa el nombre de la ruta | 5 |
| panel: muestra el nombre del menú (lista y aviso de olvidar) | 5, 7 |
| panel: categoría que ya no está en el menú, con mayúscula | 5, 21 |
| panel: señala el Edge viejo | 4 |
| panel: muestra la versión | 4, 21 |
| panel: dice desde cuándo | 4, 21 |
| index: huella al día | 2 |
| index: manda el papel | 2, 21 |
| index: usa el estado del módulo | 21 |
| index: ofrece olvidar | 2, 21 |

La primera versión de la mordida «compara categorías…» no mordió, y no por
falta de prueba: el servidor ya guarda la clave normalizada, así que volver a
normalizarla del lado de la ruta no cambiaba nada. La que importa es la del
lado del menú («Ensaladas Frías» contra «ensaladas frias»), y esa sí muerde.
