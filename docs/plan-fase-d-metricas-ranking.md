# Plan técnico — Fase D: Métricas y ranking de repartidores

**Estado: planeación únicamente. No se creó la rama
`feat/red-repartidores-metricas-ranking` — ver "Decisiones funcionales
pendientes" al final, que deben resolverse con el propietario antes de
empezar a implementar.**

## Inventario de datos ya existentes (inspección de código, sin inventar nada)

Antes de proponer cualquier tabla o migración nueva, esto es lo que ya
existe y de dónde sale cada dato:

| Tabla / columna | Qué contiene hoy | Relevante para |
|---|---|---|
| `pedidos_activos.folio, estado, datos (JSONB), negocio_id, created_at, updated_at` | Todo pedido; `datos->>'repartidor_id'`/`repartidor_nombre'` cuando hay asignación; `datos->>'modalidad'`, `datos->>'canal'`, `datos->>'rappi_order_id'` (o similar) para distinguir Rappi | Conteos de servicios, estado final, separación Xabor/Rappi |
| `notificaciones_repartidor` (migración 032) | `negocio_id, pedido_folio, repartidor_id, canal, wamid, estado (pendiente/aceptado_meta/entregado/leido/fallido/error_envio), error_codigo, error_detalle, intento_numero, created_at, updated_at` | Servicios ofrecidos, fallos, tiempo hasta la oferta |
| `notificaciones_repartidor.token_aceptacion/token_expira_at/token_usado_at` (migración 033) | Token de aceptación de un solo uso, con marca de tiempo exacta de cuándo se usó | **Tiempo de aceptación exacto** (`token_usado_at - created_at` de esa misma fila) |
| `repartidores.id, nombre, telefono, activo, negocio_id` | Identidad y elegibilidad del repartidor | Actividad por repartidor |
| `repartidores.estado, ciudad, zona, vehiculo` (migración 035) | Ciclo de vida administrativo + metadata geográfica del repartidor (no del pedido) | Desempeño por ciudad/zona **del repartidor asignado** |
| `esPedidoElegibleParaRedRepartidores` / `esPedidoDeRedExterna` (`src/utils/elegibilidadRepartidor.js`) | Criterio único ya usado en todo el sistema para distinguir pedidos de la red propia vs Rappi | Separación de entregas propias y Rappi — **reutilizar, nunca reinventar** |
| `esPedidoSinCoberturaAhora` (`src/services/database.js`) | Chequeo puntual (no histórico) de "todos los intentos fallaron y sigue sin repartidor" | Base para el conteo histórico de "sin cobertura", con adaptación a consulta agregada |
| `obtenerServiciosReparto` (`src/services/database.js:3382`) | Ya calcula `intentos, delivered, leido, failed, hora_aceptacion` por pedido, con filtros de fecha y negocio, paginado | Base directa para varias métricas — extender, no duplicar |

## Métricas posibles con los datos actuales (sin migración nueva)

| Métrica | Fórmula exacta | Consulta prevista |
|---|---|---|
| Servicios ofrecidos | `COUNT(DISTINCT pedido_folio)` en `notificaciones_repartidor`, filtrado por negocio/fecha | `SELECT COUNT(DISTINCT pedido_folio) FROM notificaciones_repartidor WHERE negocio_id=$1 AND created_at BETWEEN $2 AND $3` |
| Servicios aceptados | `COUNT(DISTINCT pedido_folio)` donde `token_usado_at IS NOT NULL` | idem + `AND token_usado_at IS NOT NULL` |
| Servicios ignorados (ver decisión pendiente #2) | pedidos con intentos pero ninguno con `token_usado_at`, y el pedido terminó asignado por otra vía o sin cobertura | requiere decisión de qué cuenta como "ignorado" vs "rechazado" — no hay evento explícito de rechazo |
| Pedidos sin cobertura (histórico) | pedido elegible, sin `repartidor_id` en `datos`, estado no `entregado`/`cancelado`, y `COUNT(intentos) = COUNT(fallidos)` | adaptar `esPedidoSinCoberturaAhora` a una consulta agregada por rango de fechas, en vez de folio único |
| Tiempo promedio de aceptación | `AVG(token_usado_at - created_at)` sobre las filas con `token_usado_at IS NOT NULL` | `SELECT AVG(token_usado_at - created_at) FROM notificaciones_repartidor WHERE negocio_id=$1 AND token_usado_at IS NOT NULL AND created_at BETWEEN $2 AND $3` |
| Tasa de aceptación | servicios aceptados / servicios ofrecidos | combinación de las dos consultas anteriores |
| Tasa de finalización | `COUNT(estado='entregado') / COUNT(repartidor_id asignado)` | join `pedidos_activos` con `notificaciones_repartidor` por folio |
| Cancelaciones (de servicios con repartidor asignado) | `COUNT(*)` en `pedidos_activos` con `estado='cancelado'` y `datos->>'repartidor_id' IS NOT NULL` | directo sobre `pedidos_activos` |
| Actividad por repartidor | `COUNT` de notificaciones/aceptaciones/entregas agrupado por `repartidor_id` | extensión de la consulta ya usada en `obtenerRosterRepartidores` (líneas 3017-3020) |
| Desempeño por negocio | las métricas anteriores agrupadas por `negocio_id` (Superadmin only) | mismas consultas sin fijar `negocio_id`, con `GROUP BY` |
| Desempeño por ciudad/zona **del repartidor** | join `notificaciones_repartidor`/`pedidos_activos` → `repartidores.ciudad/zona`, agrupado | posible con los datos ya capturados en migración 035 — **nota**: es la ciudad/zona del repartidor, no de la dirección de entrega (esa no existe como campo geográfico estructurado, solo `calle`/`colonia` en texto libre) |
| Separación Xabor vs Rappi | reutilizar `esPedidoElegibleParaRedRepartidores`/`esPedidoDeRedExterna` como filtro `WHERE`, igual que ya hace `obtenerServiciosReparto` | ya resuelto, sin cambios de criterio |
| Filtros por fecha | `created_at BETWEEN $desde AND $hasta` | ya implementado en `obtenerServiciosReparto`, mismo patrón a reutilizar en todas las consultas nuevas |

## Métricas que requieren datos nuevos

| Métrica | Por qué falta | Qué se necesitaría |
|---|---|---|
| Tiempo de recolección (repartidor llega al negocio a recoger) | No existe ningún evento ni timestamp para "el repartidor llegó a recoger el pedido" — solo hay "notificado" y "aceptado" | Nueva columna/evento explícito (p. ej. botón "Recogí el pedido" en un futuro flujo del repartidor) — **fuera del alcance actual, es una funcionalidad nueva, no solo una métrica** |
| Tiempo de entrega (aceptación → entregado) con precisión garantizada | `pedidos_activos.updated_at` se sobrescribe en cada actualización — hoy funciona *en la práctica* porque `entregado` suele ser la última escritura, pero no está garantizado por diseño | Columna nueva `entregado_at TIMESTAMPTZ` en `pedidos_activos`, poblada exactamente en el momento de la transición a `entregado` (no derivada de `updated_at`) |
| Rechazo explícito de un repartidor (vs. simplemente no responder) | El sistema nunca registra un "no, no lo tomo" — un repartidor solo puede aceptar o no hacer nada | Requeriría un nuevo estado/acción en el flujo del repartidor (fuera de alcance de una fase de métricas pura) |
| Desempeño por zona/ciudad *de la entrega* (no del repartidor) | `pedidos_activos.datos.cliente` solo tiene `calle`/`colonia` en texto libre, sin geocodificación ni columna estructurada de ciudad/zona de entrega | Requeriría geocodificación o un campo estructurado nuevo — fuera de alcance recomendado para esta fase |

## Índices necesarios (para que las consultas de agregación no degraden el sistema en producción)

```sql
-- Ya existen (migración 032): idx_notificaciones_repartidor_pedido,
-- idx_notificaciones_repartidor_repartidor, idx_notificaciones_repartidor_negocio.
-- Nuevos, si el volumen de agregación por rango de fecha lo justifica:
CREATE INDEX IF NOT EXISTS idx_notificaciones_repartidor_negocio_created
  ON notificaciones_repartidor (negocio_id, created_at);

CREATE INDEX IF NOT EXISTS idx_pedidos_activos_negocio_estado
  ON pedidos_activos (negocio_id, estado);
```
(Confirmar con `EXPLAIN ANALYZE` sobre datos reales antes de agregar —
puede que los índices ya existentes de migración 032 sean suficientes
para el volumen actual; no crear índices especulativos sin medir.)

## Posibles migraciones (solo si se aprueban las decisiones pendientes)

- `entregado_at TIMESTAMPTZ` en `pedidos_activos` (independiente de
  `updated_at`), solo si se decide que el tiempo de entrega necesita
  precisión garantizada más allá de lo que ya da `updated_at` hoy.
- Los dos índices de la sección anterior, si el volumen lo justifica.
- **Ninguna migración es estrictamente necesaria para un primer entregable
  de métricas basado en datos ya existentes** (servicios ofrecidos/
  aceptados/tasas/actividad por repartidor/desempeño por negocio — todo
  eso ya es calculable hoy).

## Endpoints propuestos

- `GET /api/superadmin/red-repartidores/metricas` — global, todos los
  negocios, con filtros `desde`, `hasta`, `negocioId?`, `ciudad?`, `zona?`.
- `GET /api/admin/repartidores/metricas` — negocio-admin, siempre acotado
  a `negocioId` de sesión (mismo patrón que las rutas ya existentes).
- `GET /api/superadmin/red-repartidores/ranking` — ranking multi-dimensión
  (nunca solo volumen — ver protección contra métricas engañosas).
- `GET .../exportar` (formato pendiente de decisión — ver decisión #4).

## Pantallas propuestas

- Nueva subvista "Métricas" dentro de la pestaña "Red de Repartidores" ya
  existente en `panel/superadmin.html` (mismo patrón de tabs que
  roster/servicios).
- Tarjetas resumen (mismo componente visual que las tarjetas de roster ya
  entregadas en Fase A/B) + tabla de ranking + filtros de fecha/negocio/
  ciudad/zona.
- Vista equivalente, acotada al propio negocio, en el panel de
  negocio-admin (`panel/index.html` o una pestaña dedicada — a definir
  según dónde ya vive la sección de repartidores del negocio-admin).

## Permisos

- Superadmin: todas las dimensiones, todos los negocios.
- Negocio-admin: solo su propio negocio (igual que el resto del módulo).
- Staff: sin acceso (igual que el resto del módulo administrativo de
  repartidores).

## Estrategia multi-tenant

Todas las consultas nuevas deben aceptar `negocioId` como filtro
obligatorio para las rutas de negocio-admin (nunca opcional en ese
contexto) y opcional solo para las rutas de Superadmin — exactamente el
mismo patrón ya usado en `obtenerServiciosReparto`. Cada consulta nueva
necesita su propia prueba de aislamiento (negocio-admin nunca ve
agregados de otro negocio), replicando el enfoque ya usado en Fase C.

## Riesgos de privacidad

- Las métricas agregadas por repartidor (tiempos, tasas) no exponen datos
  de clientes — se calculan sobre folios y timestamps, nunca sobre
  contenido de pedidos.
- Cuidado con el "ranking de repartidores" visible para negocio-admin: no
  debe exponer el desempeño de un repartidor que trabaje para otro
  negocio (un repartidor puede en teoría estar dado de alta en varios
  negocios con el mismo teléfono normalizado) — la consulta debe agrupar
  siempre por `(negocio_id, repartidor_id)`, nunca por teléfono/persona
  cruzando negocios.
- La exportación (si se implementa) debe respetar el mismo scoping por
  negocio que el resto del sistema — nunca un export global accesible a
  un negocio-admin.

## Protección contra métricas engañosas / reglas para pocas entregas

- Ningún ranking debe basarse en un solo eje (p. ej. solo volumen de
  entregas) — debe combinar al menos volumen + tasa de aceptación +
  tiempo promedio, mostrados juntos, nunca un único número ordenado.
- Repartidores con menos de un umbral mínimo de servicios (valor exacto
  pendiente de decisión — ver decisión #3) deben excluirse del ranking
  competitivo o mostrarse en una sección separada ("aún sin suficientes
  datos"), para no penalizar/premiar por una muestra estadísticamente
  insignificante.

## Estrategia de pruebas

Mismo rigor que las fases anteriores: suite dedicada
`test/fase-red-repartidores-metricas.mjs`, con datos sintéticos de
volumen y tiempos conocidos para verificar cada fórmula exactamente
(no solo "no truena"), más los casos de aislamiento multi-tenant y
exclusión de Rappi. Regresión completa en 2 Postgres Docker frescos +
build Docker antes de cualquier push, igual que en Fase C.

## Rollback

- Si se agregan columnas nuevas (`entregado_at`, índices): migración
  reversible con su archivo `_down.sql`, mismo patrón que 032-035.
- Si se agregan endpoints nuevos: son aditivos, nunca reemplazan lógica
  existente — revertir es simplemente no exponerlos/quitar la pestaña de
  UI, sin impacto en el resto del sistema.

## División recomendada en commits/subfases (una vez resueltas las decisiones)

1. Migración (solo si aplica) + consultas base de agregación (sin UI).
2. Endpoints Superadmin + negocio-admin, con pruebas de aislamiento.
3. UI: subvista "Métricas" en `panel/superadmin.html`.
4. Ranking multi-dimensión + reglas anti-métricas-engañosas.
5. Exportación (si se decide incluirla en esta fase).
6. Regresión completa + build + cierre documentado (mismo patrón que
   Fase C).

## Decisiones funcionales pendientes (agrupadas — resolver antes de crear la rama)

1. **"Sin cobertura" histórico**: ¿se cuenta un pedido como "sin
   cobertura" solo si terminó así (nunca se asignó), o también los casos
   donde eventualmente se asignó pero tras fallos previos? Afecta la
   fórmula exacta de la tasa correspondiente.
2. **"Rechazado" vs "ignorado"**: hoy no existe ningún evento de rechazo
   explícito — un repartidor solo "no hace nada". ¿Se quiere distinguir
   estos dos conceptos (requeriría una funcionalidad nueva fuera de
   métricas puras), o se reporta todo bajo un solo concepto de "no
   aceptado"?
3. **Umbral mínimo para el ranking**: ¿cuántos servicios mínimos debe
   tener un repartidor para entrar al ranking competitivo? (sugerido: a
   definir por el propietario según el volumen real de cada negocio).
4. **Formato de exportación**: ¿CSV, Excel, PDF? ¿Es necesaria en esta
   fase o puede diferirse a una fase D.1 posterior?
5. **¿Vale la pena la columna `entregado_at`?**: agrega precisión al
   tiempo de entrega, pero es la única migración de esta fase — decidir
   si se justifica ahora o se difiere hasta que se necesite con certeza.

Estas decisiones son funcionales, no técnicas — no se puede elegir una
opción razonable sin conocer la intención del negocio, así que se dejan
explícitamente para el propietario antes de iniciar la implementación.
