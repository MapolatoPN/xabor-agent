# Corrección D.1 — Universos de métricas (Red de Repartidores)

## Estado

**Corrección D.1 completa: causa raíz identificada, corregida, probada y
validada visualmente. No desplegada — pendiente de autorización.**

## Causa raíz del 1750%

`obtenerMetricasRedRepartidores` calculaba `serviciosEntregados` (numerador
de "tasa de finalización") como **cualquier** pedido de entrega a
domicilio (no-Rappi) en estado `entregado`, sin exigir evidencia de que
la entrega la hizo la Red de Repartidores. Eso incluía entregas
manuales/presenciales/históricas (35 en producción) mientras que
`serviciosAceptados` (denominador) solo contaba los realmente aceptados
por un repartidor vía token (2 en producción) — dos universos de datos
distintos usados como numerador y denominador de la misma tasa:
35 / 2 = 1750%.

Confirmado con consultas de solo lectura contra producción: de 46 pedidos
de entrega a domicilio, 11 eran Rappi, 11 tenían `repartidor_id`
(realmente asignados por la red) y 24 eran "manuales" (ni Rappi ni
`repartidor_id`) — coincide exactamente con 35 "entregados" (11+24) contra
2 aceptados reales.

## Universos de datos definidos

| Campo | Definición exacta |
|---|---|
| `pedidosCreados` | Todos los pedidos del período/negocio, cualquier modalidad — solo contexto, nunca denominador de una tasa de la red |
| `serviciosRedCreados` | Pedidos de modalidad "entrega a domicilio", excluyendo Rappi (`esPedidoDeRedExterna`) |
| `serviciosRedOfrecidos` | De los anteriores, los que generaron ≥1 fila en `notificaciones_repartidor` |
| `serviciosRedAceptados` | De los anteriores, los que tienen `token_usado_at` (aceptación real por un repartidor) |
| `serviciosRedEntregados` | `estado='entregado'` **Y** `datos.repartidor_id` presente (evidencia real de asignación por la red) |
| `entregasManuales` | `estado='entregado'` **sin** `repartidor_id` (ni Rappi, ya excluido) — sin evidencia de red ni externa |
| `serviciosRedCancelados` | `estado='cancelado'` dentro de `serviciosRedCreados` |
| `serviciosRedSinCobertura` | `derivarEstadoServicioReparto` (ya existente, reutilizada tal cual) = `sin_cobertura` |
| `entregasExternas` | Pedidos identificados como Rappi/plataforma externa |
| `notificaciones_intentadas/entregadas/leidas/fallidas` | Conteos a nivel de fila individual de `notificaciones_repartidor` — nunca por servicio |

## Fórmulas finales

```
tasaAceptacion       = serviciosRedAceptados / serviciosRedOfrecidos      (null si ofrecidos=0)
tasaFinalizacionRed  = serviciosRedEntregados / serviciosRedAceptados     (null si aceptados=0)
coberturaRed         = serviciosRedAceptados / serviciosRedCreados        (null si creados=0)
tasaEntregaNotif     = notificacionesEntregadas / notificacionesIntentadas
tasaLecturaNotif     = notificacionesLeidas / notificacionesEntregadas
tasaFalloNotif       = notificacionesFallidas / notificacionesIntentadas
```

Ninguna fórmula puede superar 100% cuando los universos son coherentes
(numerador siempre subconjunto del denominador) — verificado con prueba
dedicada. Ninguna división entre cero: siempre `null`, nunca `0` ni `NaN`.

## Tarjetas renombradas (UI)

Reorganizadas en tres grupos: "Pedidos y servicios (universo general)"
(pedidosCreados, serviciosRedCreados, entregasExternas, entregasManuales),
"Red de Repartidores (propia)" (ofrecidos, notificados, aceptados,
entregados por la red, cancelados, sin cobertura), y "Tasas de la red"
(las 3 tasas + tiempos promedio, cada una con una nota de una línea
explicando su fórmula).

## Corrección del nombre del negocio

`obtenerMetricasRedRepartidores` (bloque `porNegocio`) y
`obtenerRankingRepartidores` ahora hacen `JOIN`/lookup contra `negocios`
y devuelven `negocioNombre` junto a `negocioId` (el UUID se conserva como
identificador interno). La UI y el CSV muestran `negocioNombre` como
etiqueta principal. Probado que cada negocio muestra su nombre correcto y
que el desglose cross-negocio de Superadmin no mezcla datos entre
negocios (`docs` de prueba: "Superadmin cross-negocio ve porNegocio con
nombres, sin fuga entre negocios").

## Tratamiento de datos históricos

Nuevo campo `avisos.datosHistoricosIncompletos` (booleano) + mensaje fijo,
activado cuando algún servicio del universo tiene 0 intentos de
notificación (anterior a la migración 032). Nunca se infiere ni
reconstruye una fecha o notificación histórica — los registros 0/0/0 se
muestran como "sin instrumentación", no como "sin actividad confirmada".

## Ranking corregido

Ya usaba correctamente `datos.repartidor_id` para contar entregas por
repartidor (nunca contaba Rappi ni manuales) — no requirió cambios de
lógica, solo se le agregó `negocioNombre`. Verificado con prueba
dedicada que Rappi nunca aparece en el ranking.

## CSV corregido

Columna nueva `Negocio` (nombre legible) antes de `NegocioId` (UUID,
identificador interno) en la exportación de ranking de Superadmin.

## Pruebas específicas (15 de las 17 pedidas — 16 y 17 son regresión/build)

`test/fase-red-repartidores-metricas-universos.mjs` — 15/15, incluyendo
la reproducción exacta del bug real (35/3/2/2 → 100%, nunca 1750%) en un
negocio aislado propio de la prueba (para que el conteo exacto no
dependa de qué más haya en la base compartida de la batería).
`test/fase-red-repartidores-metricas.mjs` actualizado a los nuevos
nombres de campo — 29/29.

## Regresión y build

Dos instancias Postgres 16 Docker independientes, cada una en solitario
(sin builds ni otros procesos pesados corriendo al mismo tiempo — un
primer intento con un build Docker concurrente produjo ~11 fallos
espurios por "servidor no respondió /health", confirmados como carga de
máquina al repetir sin esa concurrencia y salir limpio). Resultado final:
limpio en ambas instancias salvo los 2 flakes pre-existentes ya
documentados en fases anteriores (`fase-p0-aislamiento-pedidos.mjs`,
`fase-rollout-completo-repartidores.mjs`), ambos reconfirmados limpios en
aislamiento. Un tercer caso nuevo (`fase-chat-manual.mjs`, no relacionado
con este cambio) falló una sola vez bajo la misma carga y se confirmó
limpio (22/22) en aislamiento inmediatamente después.

Build Docker de producción: exitoso.

## Validación visual

Confirmada en Docker local con datos sintéticos: tasa de finalización ya
no supera 100% en ningún escenario probado, nombres de negocio en vez de
UUID en "Desempeño por negocio" y en el ranking, aviso histórico visible,
sin errores de consola, responsivo en 375px.

## Riesgos y pendientes

- El score de ranking y el resto de la lógica de Fase D no cambiaron —
  solo los universos/fórmulas de las tarjetas de métricas.
- Los 7 grupos de duplicados de repartidores siguen sin fusionar (fuera
  de alcance, plan ya documentado aparte).
- UI de negocio-admin para métricas sigue diferida (ya documentado en el
  cierre de Fase D).
