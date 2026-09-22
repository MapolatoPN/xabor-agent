# Handoff a ChatGPT — Corte de caja: descuentos, promociones y Rewards

**Fecha:** 22 de septiembre de 2026
**De:** sesión de Claude Code (Sonnet 5), en un worktree dedicado
**Para:** quien retome esto en ChatGPT (u otra sesión), sin contexto previo

Este documento es autocontenido: no asume que leíste la conversación que lo
generó. Si algo no está aquí, está en los archivos que se referencian por
ruta — léelos antes de tocar código.

---

## 1. Qué es Xabor (contexto mínimo)

Sistema de gestión de pedidos para restaurante (WhatsApp + llamada + POS
presencial), panel web en tiempo real, impresión de comandas/tickets,
reportes por WhatsApp. Node 20 + Express (ESModules), PostgreSQL en Railway,
WebSocket nativo. Todo el contexto de arquitectura, convenciones y reglas
operativas vive en **`CLAUDE.md`** en la raíz del repo — léelo primero, en
particular las secciones:

- **"Principio innegociable: Estabilidad operacional primero"** — lista los
  archivos protegidos (`brain.js`, `whatsapp-meta.js`, `orderManager.js`,
  `panel/index.html`, rutas `/pedidos`) que requieren explicar el riesgo y
  pedir aprobación antes de tocarlos.
- **"Git — regla crítica"** — los commits se hacen **siempre desde
  PowerShell en Windows, nunca desde el sandbox de un agente** (corrompe
  archivos, trunca contenido). Si el agente que retoma esto puede ejecutar
  comandos, debe respetar esta regla igual.
- **"Entorno local de pruebas (Docker)"** — la receta completa para levantar
  Postgres local y aplicar migraciones. Se usó tal cual para validar esta
  fase (detalle en §5).
- **"Desplegar a producción"** — el despliegue es un acto explícito
  (`railway redeploy --yes --from-source`), nunca automático desde un push.

## 2. Objetivo del dueño del negocio (por qué existe esta tarea)

> Llevar la administración de promociones y descuentos, y al final del día
> saber cuánto del ingreso se fue a promociones y descuentos.

Se dividió el trabajo en fases por riesgo. **Esta sesión completó la Fase
1** (el número que el dueño pidió, sin tocar el arqueo de caja). Las fases
2-4 quedan pendientes — ver §7.

## 3. Estado exacto del repo en este momento

```
Worktree:  C:\xabor-agent\.claude\worktrees\promos-descuentos-corte
Rama:      worktree-promos-descuentos-corte
Base:      origin/main @ ae18d7f ("Documentar que produccion despliega
           desde una rama deploy/*, no desde main")
```

`git status --short`:
```
 M panel/index.html
 M src/server.js
 M src/services/cortesCaja.js
?? docs/corte-descuentos-promociones-fase1.md
?? docs/handoff-corte-descuentos-promociones-chatgpt.md   (este archivo)
?? migrations/088_cortes_descuentos_promociones.sql
?? migrations/088_cortes_descuentos_promociones_down.sql
?? scripts/predeploy-088-cortes-descuentos-promociones.mjs
```

**Nada de esto está commiteado.** El dueño (Mario) no ha decidido todavía si
commitear él mismo desde PowerShell o pedir el mensaje de commit armado.

### Por qué es un worktree separado, y qué NO tocar

Existe otro worktree, `C:\xabor-agent\.claude\worktrees\peaceful-blackwell-ebf703`
(rama `rescue/mesero-tool-agent`), con **828 líneas sin commitear de una
feature de facturación (CFDI) completamente distinta** — `facturacionService.js`,
migración `087_clientes_fiscales.sql`, etc. Es trabajo de otra tarea, a
medias, de otra persona/sesión. **No se tocó y no debe tocarse** al
continuar este trabajo. Por eso esta tarea se hizo en un worktree nuevo,
partiendo de `main` limpio.

### main está DETRÁS de lo que corre en producción

Importante para no sorprenderse: `main` solo llega hasta la migración `078`.
La rama `rescue/mesero-tool-agent` (y la rama de despliegue real,
`prod/mesero-shadow-v3`) ya traen las migraciones `079`-`086` (agente de
WhatsApp nuevo, Rewards en tienda en línea, `src/services/descuentos.js`
compartido, etc.), que **no existen en `main`**. Esta fase se construyó
deliberadamente contra `main` porque el objetivo (corte de caja) no depende
de esas features — pero si en algún momento esta rama se integra con
`rescue/mesero-tool-agent`, hay que revisar si algo cambió en
`cortesCaja.js`, `tiendaCheckout.js` o el formato de `pedidos_activos.datos`
en el camino.

## 4. Qué se hizo (Fase 1)

Documentado en detalle en **[`docs/corte-descuentos-promociones-fase1.md`](corte-descuentos-promociones-fase1.md)**
— léelo completo antes de escribir código nuevo, tiene la tabla de qué canal
guarda el descuento de qué forma. Resumen:

- El corte de caja (`src/services/cortesCaja.js`, endpoint
  `GET /api/corte-caja`, ticket térmico, reporte diario de WhatsApp, panel)
  ahora calcula y muestra, por día: **descuento manual**, **descuento
  promocional** y **Rewards canjeados**.
- Son campos **informativos**: ya están incluidos en `ventas_totales` /
  `total` de cada pedido. No cambian `efectivo_esperado` ni el arqueo.
- El dato se arma leyendo `pedidos_activos.datos` (que guarda el descuento
  de forma distinta según canal — POS, restaurante, WhatsApp, tienda en
  línea) y `rewards_movements` (fuente única para Rewards, no depende del
  canal).
- Migración `088` agrega tres columnas nullable-por-DEFAULT a `cortes_caja`.
  Numerada 088 a propósito, por encima de la más alta conocida en cualquier
  rama viva (ver §3) para no chocar más adelante.

### Bug real encontrado y corregido durante la validación

`rewards_movements.tenant_id` es `TEXT`; `pedidos_activos.negocio_id` es
`UUID`. El primer intento de JOIN entre ambas tablas habría fallado en
Postgres (`operator does not exist: uuid = text`). Se corrigió con el mismo
cast que ya usa `rewardsService.js` (`pa.negocio_id::text = rm.tenant_id`).
Esto NO se detectó con `node --check` (solo valida sintaxis) — se detectó
ejecutando la query contra una base real. **Lección para quien continúe:
`node --check` no basta para código con SQL embebido; hay que ejecutarlo.**

## 5. Cómo se validó (repetible)

Se siguió la receta de `CLAUDE.md` §"Entorno local de pruebas (Docker)"
contra una base **desechable y dedicada** (no `edged1`, que es compartida
entre sesiones):

```powershell
docker exec pg-restv2 psql -U postgres -c "CREATE DATABASE edged1_promos_test"
```

Luego, con `DATABASE_URL` apuntando a esa base:
1. `node test/aplicar-migraciones.mjs` (tablas base + 001-050)
2. Los `scripts/predeploy-0NN-*.mjs` de la 051 a la 078, en orden (main solo
   llega hasta ahí — ver §3)
3. `065` y `066` no tienen script `predeploy`: se aplicaron ejecutando el
   `.sql` directamente contra el pool (mismo patrón, sin `psql` porque no
   está disponible en el shell de esta sesión — ver nota de sandbox abajo)
4. `node scripts/predeploy-088-cortes-descuentos-promociones.mjs`
5. `node test/seed-datos-prueba.mjs` (genera `test/.datos-prueba.json`)

Con eso:
- Se sembraron pedidos sintéticos de los 4 canales (POS con descuento
  combinado, restaurante manual puro, WhatsApp promocional puro, tienda con
  promoción anidada) + un pedido abierto (`por_cobrar`) + un pedido
  cancelado con descuento y canje de Rewards, para probar las exclusiones.
  Los 5 escenarios dieron el resultado exacto esperado.
- Se corrieron las suites existentes que tocan este código:
  **`test/fase-cortes-caja.mjs` → 38/38 OK**,
  **`test/fase-cobro-diferido.mjs` → 28/28 OK**. Sin regresión.
- La base de prueba se borró al terminar (`DROP DATABASE edged1_promos_test`).

El script de la prueba ad-hoc (fixtures + aserciones) NO forma parte del
repo — vivió en el scratchpad de la sesión y no quedó guardado. Si hace
falta repetir la validación, hay que reconstruirlo siguiendo la tabla de
§4 del doc de Fase 1 (qué campo de `datos` usa cada canal).

### Nota de entorno (sandbox de esta sesión, puede no aplicar en la tuya)

- No hay binario `psql` en el shell Bash disponible; se usó `pg` desde Node
  directamente (`pool.query(fs.readFileSync(archivo, 'utf8'))`) para aplicar
  los `.sql` sueltos.
- El shell rechazó `eval`/`source` con variables de entorno (política de
  aislamiento del worktree) — hubo que exportar cada variable de
  `dev-local.env.cmd` con `export VAR="valor"` literal, una por una.
- La contraseña de Postgres local y las demás variables están en
  `C:\xabor-agent\dev-local.env.cmd` (ignorado por git, ya debe existir en
  la máquina si se siguió la receta de `CLAUDE.md` antes).

## 6. Archivos tocados — para orientarte rápido

| Archivo | Qué cambió |
|---|---|
| `migrations/088_cortes_descuentos_promociones.sql` (+`_down`) | 3 columnas nuevas en `cortes_caja` |
| `scripts/predeploy-088-cortes-descuentos-promociones.mjs` | Aplica y verifica la 088 (patrón calcado de `predeploy-064`) |
| `src/services/cortesCaja.js` | `calcularCorteVivo`: nueva query a `rewards_movements`, split manual/promocional por pedido. `cerrarCorte`: persiste los 3 campos. `ticketCorte`: los imprime. `listarCortes`: los incluye en el histórico |
| `src/server.js` | `GET /api/corte-caja` (rama de corte ya cerrado) expone los 3 campos; `enviarReporteDiario()` agrega un bloque al mensaje de WhatsApp (fail-safe: si falla, el resto del reporte se envía igual) |
| `panel/index.html` | `cargarCorte()`: tarjeta "🎁 Descuentos y Rewards" en la vista del día; `cargarHistorialCortes()`: columna "Regalado" en la tabla de histórico |
| `docs/corte-descuentos-promociones-fase1.md` | Detalle completo de esta fase (léelo antes de tocar nada) |

## 7. Qué falta (fases siguientes, en orden de valor/riesgo)

**Fase 2 — formato único de descuento.** Hoy hay tres formas distintas de
guardar el desglose según canal (ver tabla en el doc de Fase 1). Unificar en
un solo bloque `datos.descuentos { manual, promociones[], rewards, total }`
escrito desde los 4 puntos de creación/cobro, sin romper los campos actuales
(panel, comanda y ticket ya los leen). Riesgo medio: toca código de
creación de pedidos, aunque no los archivos "protegidos" de CLAUDE.md
directamente en todos los casos — revisar cuáles sí.

**Fase 3 — atribución de uso por canal.** `registrarUsosPromociones` solo se
llama desde `tiendaCheckout.js` (tienda en línea). POS y WhatsApp/agente
calculan y otorgan el descuento pero nunca registran el uso en
`tienda_promocion_usos` — los límites de uso (`limite_usos`,
`limite_por_cliente`) no se aplican de verdad fuera de la tienda, y las
métricas de `/api/admin/tienda/metricas` solo ven ventas de la tienda en
línea. **Esto SÍ toca camino crítico** (`orderManager.js`, rutas
`/pedidos`) — requiere explicar el riesgo y pedir aprobación explícita del
dueño antes de tocarlo, por CLAUDE.md.

**Fase 4 — administración y reporte.** Rango de fechas en
`listarPromociones`/métricas (hoy suman toda la historia sin filtro,
mientras que el resto de `/api/admin/tienda/metricas` sí filtra por
periodo — son inconsistentes si se leen juntos). Un reporte "Promociones y
descuentos" por promoción, canal y quién autorizó.

**Gap conocido y documentado, no asignado a ninguna fase todavía:** el envío
regalado por promociones de envío gratis no se contabiliza en ningún lado
para el canal POS — el motor de promociones puede autorizar envío gratis
pero la ruta `/api/pos/pedido` en `src/server.js` descarta esa bandera al
armar el pedido (filtra las promos de `envioGratis` del arreglo guardado y
nunca pone `costo_envio` en 0). Es un bug de comportamiento preexistente,
no algo que esta fase haya introducido — se dejó documentado en vez de
arreglado porque corregirlo es un cambio de comportamiento, no de reporte.

## 8. Antes de escribir código: checklist

1. Lee `CLAUDE.md` completo, en particular los archivos protegidos y la
   regla de git.
2. Lee `docs/corte-descuentos-promociones-fase1.md` completo.
3. Confirma en qué worktree/rama estás y que sigue limpio de la feature de
   facturación del otro worktree (§3).
4. Si vas a tocar la Fase 2 o 3, decide primero si el archivo que vas a
   modificar está en la lista de protegidos — si lo está, la instrucción del
   repo es explicar el riesgo y pedir aprobación antes, no proceder directo.
5. Si vas a validar con base de datos, usa una base dedicada y desechable
   (nunca `edged1` directo) y bórrala al terminar.
6. No commitees desde el entorno del agente. Prepara el mensaje de commit y
   pide que se ejecute desde PowerShell, o entrega el diff para que el
   dueño decida.
