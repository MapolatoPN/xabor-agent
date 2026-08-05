# Cierre técnico — Fase D: Red de Repartidores, métricas y ranking

## Objetivo

Agregar métricas operativas y un ranking equilibrado de repartidores al
módulo Red de Repartidores (Superadmin), reutilizando al máximo los datos
y funciones ya existentes de las fases A-C, sin modificar retroactivamente
ningún dato histórico.

## Rama, commits

| Campo | Valor |
|---|---|
| Rama | `feat/red-repartidores-metricas-ranking` |
| Commit base | `5cecbe2` (código de Fase C + cierre + validación visual) |
| Commits de esta fase | `eae7b0a` (plan calidad de datos), `5602e54` (migración + servicios), `8b799e5` (endpoints), `555aa57` (UI), `ffbf8f2` (pruebas) |

## Migración

`036_entregado_at_pedidos` — aditiva, reversible (`_down.sql`), con
verificación de solo lectura (`_check.sql`) y script `predeploy-036`
dedicado, siguiendo exactamente el patrón de 032-035. `entregado_at` se
puebla únicamente hacia adelante, nunca con fechas históricas inventadas.

## Métricas implementadas

Tarjetas: servicios creados/ofrecidos/aceptados/entregados/cancelados/sin
cobertura, repartidores notificados, tasa de aceptación, tasa de
finalización, tiempo promedio de aceptación y de entrega. Embudo de
notificaciones (intentados/entregados por WhatsApp/leídos/fallidos/
aceptados/ignorados/rechazados — este último siempre `null`, nunca `0`,
porque no existe mecanismo de rechazo explícito hoy). Desglose por
negocio (solo Superadmin cross-negocio) y por ciudad/zona del repartidor
(nunca del pedido — esa geo no existe estructurada). Entregas externas
(Rappi) siempre separadas, nunca mezcladas en ninguna tasa de la red
propia.

## Ranking

Tres grupos: elegible (≥10 ofrecidos y ≥5 entregados), muestra
insuficiente, y suspendidos/dados de baja (siempre en su propio grupo,
sin importar volumen). Fórmula del score (solo para el grupo elegible):

```
score = (0.35·tasaAceptacion + 0.35·tasaFinalizacion + 0.20·velocidad + 0.10·(1-tasaCancelacion)) × factorConfianza
```

- `velocidad` = 1 − (tiempoPromedioAceptación / 1800s), acotado [0,1] —
  1800s es la misma ventana de expiración del token ya usada en Fase C.
- `factorConfianza` = min(1, ofrecidos / 30) — atenúa el score de quien
  apenas cumple el mínimo sin excluirlo, y evita que el volumen por sí
  solo siga premiando indefinidamente a partir de cierto tamaño de
  muestra.
- Nunca se basa solo en volumen, tal como se pidió.
- Los 7 grupos de duplicados reales detectados en producción (ver
  `docs/plan-calidad-datos-repartidores.md`) **no se fusionan** — cada
  `repartidores.id` se puntúa por separado; se marca `posibleDuplicado`
  para que el Superadmin lo vea, sin alterar ningún dato.

## Endpoints y permisos

Superadmin: `/api/superadmin/red-repartidores/{metricas,ranking,ranking/exportar.csv}`
(negocioId opcional). Negocio-admin: mismos tres bajo `/api/admin/repartidores/`
— negocioId siempre de `req.negocioId` (sesión), nunca del query string.
Staff: 403 en ambos (vía `requireAdminSeguro`/`requireSuperadmin` ya
existentes, sin código nuevo de permisos).

## Interfaz

Nueva subvista "Métricas y ranking" dentro de Red de Repartidores en
`panel/superadmin.html` — validada visualmente en Docker local con datos
sintéticos conocidos (números verificados uno a uno contra los datos
sembrados) y confirmada la reflow responsiva en 375px (`display:flex` vía
computedStyle, mismo patrón que roster/servicios).

**Pendiente explícito**: no se construyó una pantalla equivalente en el
panel de negocio-admin (`panel/index.html`) — los endpoints y permisos ya
están listos y probados, pero la UI queda diferida para no comprometer el
rigor de pruebas visuales de esta entrega.

## Exportación CSV

Formato RFC 4180 (comillas dobles escapadas, sin dependencias nuevas),
BOM UTF-8. Probado con nombres que incluyen comas y comillas.

## Riesgos conocidos

- Ranking no fusiona duplicados — un mismo repartidor real dado de alta
  dos veces divide su actividad entre dos filas (documentado, con
  plan de fusión separado sin implementar).
- Sin UI de negocio-admin todavía (ver "Pendiente explícito").
- El score es una primera fórmula razonable, no validada con datos reales
  de producción a volumen — puede requerir ajuste de pesos una vez que
  haya suficiente historial.

## Pruebas y regresión

29/29 pruebas nuevas (`test/fase-red-repartidores-metricas.mjs`).
Regresión completa en dos instancias Postgres 16 Docker independientes:
limpia salvo los 2 flakes ya documentados y pre-existentes
(`fase-p0-aislamiento-pedidos.mjs`, `fase-rollout-completo-repartidores.mjs`),
ambos reproducidos y confirmados limpios en aislamiento en esta misma
sesión. Build Docker de producción: exitoso.

## Rollback

- **Código**: revertir los 5 commits de esta fase sobre `5cecbe2`.
- **Migración**: `migrations/036_entregado_at_pedidos_down.sql` elimina
  la columna sin pérdida de datos derivables (nunca fue fuente única de
  verdad de nada más).
- **Producción**: como esta fase no se ha desplegado, no aplica rollback
  de deployment — el commit base `5cecbe2` de la rama anterior sigue
  siendo lo único en producción.
