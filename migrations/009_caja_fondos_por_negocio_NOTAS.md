# Migración 009 — Aislamiento de `caja_fondos` por negocio

Rama: `feature/multitenancy-operativo`
Worktree: `C:/xabor-multitenancy-operativo`

## Contexto

Cierra el bloqueo documentado en el commit `3738d91`
("fix(multitenancy): aislar ventas e historial por negocio"): `caja_fondos`
tenía `fecha DATE NOT NULL UNIQUE` — una sola fila **global** por fecha,
compartida por todos los negocios. La migración 007 ya había agregado
`negocio_id` (nullable, FK `RESTRICT`, índice) a la tabla, pero
`guardarFondoCaja` nunca la escribía, así que dos negocios activos el
mismo día veían y se pisaban el mismo fondo inicial.

## Archivos

| Archivo | Propósito |
|---|---|
| `009_caja_fondos_por_negocio.sql` | Migración up: backfill a Nonna Maye, `negocio_id` a `NOT NULL`, reemplaza `UNIQUE(fecha)` por `UNIQUE(negocio_id, fecha)` |
| `009_caja_fondos_por_negocio_seed.sql` | Sin datos nuevos que sembrar (ver explicación en el propio archivo) |
| `009_check_caja_fondos_por_negocio.sql` | Validación de solo lectura: columna, NOT NULL, FK, índice, constraint compuesta, ausencia de la UNIQUE de una sola columna, ausencia de duplicados |
| `009_caja_fondos_por_negocio_down.sql` | Rollback: revierte únicamente `NOT NULL` y la restricción única — no toca columna/FK/índice (son de la migración 007) |

## Diseño

- **No se creó una tabla nueva**: `negocio_id` (columna, FK `RESTRICT`,
  índice) ya existía desde la migración 007. Esta migración solo
  endurece lo que ya estaba ahí (nullable → `NOT NULL`) y corrige la
  restricción única, que es el problema real.
- **`UNIQUE(negocio_id, fecha)`** reemplaza `UNIQUE(fecha)`, identificada
  y reemplazada por composición de columnas vía `pg_constraint`/
  `pg_attribute` (mismo patrón que la migración 004 usó para
  `menu_productos.codigo` → `(negocio_id, codigo)`), nunca por nombre de
  constraint asumido.
- **Guarda de duplicados antes de crear la constraint**: se verifica que
  no existan pares `(negocio_id, fecha)` repetidos antes del `ADD
  CONSTRAINT`. No debería ser posible dado que `fecha` era única
  globalmente antes de esta migración (como mucho una fila por fecha,
  con un solo `negocio_id` por backfill), pero se verifica en vez de
  asumirlo.
- **No se renombró `fondo` a `monto`**: la columna real se llama `fondo`
  (`DECIMAL(10,2)`) desde la definición original en `initDB()`; el
  nombre `monto` en las instrucciones de esta fase se refiere al
  concepto, no a un requisito de renombrar la columna.
- **No se agregó `updated_at`**: la tabla nunca tuvo esa columna: no se
  inventó una nueva fuera del alcance de aislar por negocio.
- **`ON CONFLICT (negocio_id, fecha) DO NOTHING`**: se conserva
  exactamente la semántica previa (`ON CONFLICT (fecha) DO NOTHING` —
  "primer valor del día gana", nunca se sobreescribe), solo se amplía la
  clave del conflicto a la nueva restricción compuesta.

## Backfill

Todas las filas preexistentes (antes de esta migración) se asignan a
Nonna Maye vía `negocios.slug = 'nonna-maye'`, idempotente
(`WHERE negocio_id IS NULL`), y la migración aborta con
`RAISE EXCEPTION` si Nonna Maye no existe — no se inventa ningún UUID.
Probado empíricamente contra Postgres efímero con dos filas preexistentes
del esquema viejo (`fecha` sin `negocio_id`, insertadas directamente
antes de aplicar 009): ambas terminaron con `negocio_id` = Nonna Maye
tras la migración.

## `database.js`

`guardarFondoCaja(fecha, monto, negocioId)` y
`obtenerFondoCaja(fecha, negocioId)`: `negocioId` ahora es obligatorio,
falla cerrado (sin escritura/lectura global) si falta o está vacío —
mismo patrón que `obtenerVentas`/`obtenerResumenVentas`/
`obtenerPedidosEntregados` del commit anterior. Sin fallback a Nonna
Maye dentro de `database.js`.

## `server.js`

- `POST /api/caja/fondo` y `GET /api/caja/fondo` pasan exclusivamente
  `req.negocioId`.
- `GET /api/corte-caja` pasa `req.negocioId` a `obtenerFondoCaja` (además
  de a `obtenerVentas`/`obtenerResumenVentas`, ya resueltas en la fase
  anterior) — el comentario `⚠ AISLAMIENTO PARCIAL / PENDIENTE DE
  SEGURIDAD` se reemplazó por uno que confirma el aislamiento completo,
  **porque las 29 pruebas obligatorias lo confirman** (no se actualizó
  el comentario antes de probar).
- `enviarReporteDiario()` (job legado sin contexto de request) también
  pasa `negocioIdReporte` (el mismo `resolverNegocioActualPorDefecto()`
  ya usado para ventas/resumen desde la fase anterior) a
  `obtenerFondoCaja`, para no romper el reporte nocturno de WhatsApp de
  Nonna Maye.

## Resultado

`GET /api/corte-caja` queda **completamente aislado** por negocio:
ventas, resumen y fondo de caja se filtran/escriben con `req.negocioId`.
Dos negocios pueden tener cada uno su propio `fondo_inicial` el mismo día
sin pisarse — verificado en vivo (pruebas 20-24).

## Rollback

`009_caja_fondos_por_negocio_down.sql` revierte únicamente lo que 009
cambió (`NOT NULL` → nullable, `UNIQUE(negocio_id, fecha)` →
`UNIQUE(fecha)`). No elimina la columna `negocio_id`, su FK ni su
índice — esos pertenecen a la migración 007, no a esta.

**El down es posible únicamente mientras no existan fondos de múltiples
negocios para una misma fecha.** Esa es la única condición real que
importa: dos negocios con fondos en fechas *distintas* no bloquean el
rollback (no hay ningún dato que perder ni ninguna elección arbitraria
que hacer); dos negocios con fondos en la *misma* fecha sí lo bloquean,
porque `UNIQUE(fecha)` global no puede coexistir físicamente con dos
filas que comparten esa fecha.

**Preflight obligatorio, antes de cualquier `ALTER` destructivo:**

```sql
SELECT fecha
FROM caja_fondos
GROUP BY fecha
HAVING COUNT(*) > 1
```

Si esta consulta devuelve alguna fila, el rollback **aborta por
completo** con un error que lista las fechas en conflicto. Nunca borra
filas, nunca combina fondos, nunca elige arbitrariamente un negocio,
nunca quita `negocio_id`, nunca quita `NOT NULL`, nunca elimina
`UNIQUE(negocio_id, fecha)` — el esquema queda exactamente como estaba
antes de intentar el rollback. **Una vez que existan fechas
compartidas entre negocios, revertir requiere una estrategia manual de
datos** (decidir explícitamente qué fondo debe prevalecer por fecha, o
simplemente conservar el esquema multiempresa en vez de revertir) antes
de poder reintentarlo — esta migración nunca decide eso por sí sola.

**Transacción explícita** (`BEGIN` / `COMMIT` literales en el archivo):
todo el rollback corre como una sola unidad atómica. Si el preflight
aborta, o si cualquier paso posterior fallara por cualquier motivo, la
transacción completa se revierte — nunca queda una migración
parcialmente revertida (por ejemplo, `NOT NULL` ya quitado pero la
constraint compuesta todavía sin restaurar `UNIQUE(fecha)`).

**La migración no es destructiva** en ningún escenario: ni el up, ni el
down cuando procede, ni el down cuando aborta, eliminan o modifican el
contenido de ninguna fila de `caja_fondos`. Solo se tocan constraints,
nulabilidad e índices.

Verificado que el down no toca `negocios`, `usuarios`,
`usuario_negocios`, `integraciones_canal` ni `pedidos_activos`, y que
`negocio_id` fue agregado originalmente por la migración **007** (no por
009) — el down de 009 nunca lo elimina, solo relaja su nulabilidad
cuando el rollback puede proceder de forma segura.

## Alcance de esta fase

- No se tocó `orderManager.js`, Rappi, WhatsApp, Voz, WebSocket,
  `print-agent.js`, rewards, `panel/index.html`, `package.json` ni
  `package-lock.json`.
- No se ejecutó ninguna migración contra Railway/producción — todo se
  probó contra Postgres efímero local (29 pruebas obligatorias, 33
  aserciones, 0 fallos).
- No se agregó ninguna dependencia nueva.
