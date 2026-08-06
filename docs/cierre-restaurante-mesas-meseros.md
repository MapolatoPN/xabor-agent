# Cierre — Restaurante: mesas, meseros y cuentas (Frente C)

## Objetivo
Módulo simple de servicio en mesa: cuadrícula de mesas numeradas (sin mapa
ni reservaciones), apertura atómica, comandas incrementales, UNA cuenta por
mesa con división para cobrar (productos / partes iguales / pagos parciales
y mixtos / propina) y cierre con saldo cero.

## Rama y commits
- Rama: `integration/restaurante-mesas-meseros` · base **`594c464`**
  (producción actual, deployment `c925e2b1`).
- Integrados: `fe77fc2`, `1f25a5b`, `82a3ffb`, `7af8f33` (merge `80d0b4d`)
  + commits de la revisión de integración (advertencia de caja, predeploy
  039, concurrencia ampliada — ver `git log 594c464..HEAD`).
- Conflictos del merge: 2 triviales ("ambas ramas agregan en la misma
  ancla") — runner de migraciones de prueba (037+038 vs 039 → los tres) y
  bloque de imports de server.js (redRepartidores vs restauranteService →
  ambos). Verificación funcional: A (3 chequeos sop, Central) y B (gate,
  Central de Reparto) intactos; 12 rutas /api/restaurante presentes.

## Arquitectura y tablas (migración 039)
`restaurante_cuentas` / `restaurante_cuenta_items` /
`restaurante_cuenta_pagos` — relacionales, NO extienden `pedidos_activos`.
Concurrencia resuelta en la base: índice único parcial
(negocio_id, mesa_numero) WHERE estado='abierta' para apertura/movimiento;
`FOR UPDATE` + saldo en consulta separada (post-lock, snapshot fresco) para
comandas/pagos/cierre. Módulo `restaurante` agregado al CHECK de
negocio_modulos (patrón 015/026/028). Sin backfill: tablas vacías, el
módulo se activa POR NEGOCIO desde Superadmin.

## Endpoints (12, gateados por requireModulo('restaurante'))
mesas · mesas/abrir · cuentas/:id · items · comanda · items/:id/cancelar
(admin) · pagos · dividir · cerrar · mover · reabrir (admin) · indicadores.
Mapa explícito de códigos de error → HTTP (409 conflictos, 400 validación,
404 inexistente/ajeno).

## Permisos (mapeo actual, sin roles inventados)
- **staff = mesero y caja**: abrir mesa, agregar items, enviar comanda,
  registrar pagos, dividir, mover, cerrar.
- **admin**: además cancelar items (motivo obligatorio, auditado) y
  reabrir cuentas.
- Superadmin: vía sesión de soporte (negocio fijado en el token; la consola
  sigue bloqueada desde soporte — regresión A 25/25 en esta rama).
- La separación fina mesero/caja llega con la arquitectura de roles futura.
Notas y motivos se guardan como texto y se escapan al renderizar
(escapado HTML en mesas.html).

## Concurrencia validada (suite 19/19 ×2 bases PG18.4)
Apertura simultánea (uno gana) · doble envío de comanda (una sola,
SIN_ITEMS_PENDIENTES al otro) · comanda adicional solo con lo nuevo · dos
cajas al mismo saldo (un pago gana) · **cierre vs pago simultáneos (jamás
cerrada con saldo)** · **movimiento concurrente a la misma mesa (uno
gana)** · **cancelación durante envío (cancelado prevalece, sin
duplicados)** · **reapertura concurrente (una gana)** · Mesa 1 en dos
negocios a la vez · cuenta ajena invisible/intocable · módulo apagado 403.
Todas por evento/constraint — sin sleeps arbitrarios.

## Impresión (contrato C8 sobre printRouter)
Cada trabajo lleva: negocio, mesa, personas, mesero, tipo
(inicial/adicional/cancelacion), SOLO los items de esa comanda con
modificadores/notas (motivo en la cancelación); la sucursal la resuelve
printRouter como en todo el sistema. Sin impresora → `omitido` (fail-safe;
la cuenta digital es la fuente de verdad); el doble clic no genera dos
trabajos porque el segundo envío no tiene items pendientes (la idempotencia
de impresión ES la idempotencia de la comanda). **Diferido documentado**:
la PLANTILLA física del ticket en print-agent no reconoce aún los campos
mesa/personas/tipo — imprime el formato genérico de pedido; el objeto ya
lleva todo para cuando se ajuste la plantilla.

## UI (`panel/mesas.html`)
Cuadrícula libre/ocupada con mesero/personas/total/saldo, diálogo de
cuenta (productos, modificadores, notas, comandas, cancelación solo admin,
pagos con división y propina, mover, cerrar), mensajes de error del
backend, estados vacíos, 375px sin desbordes (validada en la fase de
desarrollo). Solo visible/operable con módulo `restaurante` activo (backend
403 + chequeo de módulos en el cliente). **Advertencia permanente de
piloto** (ver siguiente sección).

## Integración con caja/reportes — BLOQUEO EXPLÍCITO (Opción A)
**Fuente de verdad de ventas hoy**: `pedidos_activos` (de ahí leen
`/api/ventas` y `/api/ventas/resumen`; `pedidos` es historial por cliente).
Las cuentas de restaurante NO llegan ahí ⇒ **una cuenta cerrada no aparece
en ventas ni cortes de caja**. Decisión: **Opción A — piloto aislado con
advertencia visible** en mesas.html: "⚠ Piloto: las cuentas de restaurante
todavía no se integran al cierre de caja ni a los reportes generales de
ventas." Se descartó la Opción B (insertar en `pedidos_activos` al cerrar)
porque esa tabla alimenta el panel de comandas, impresión, archivado y el
contador de folios — inyectar cuentas cerradas arriesga dobles impresiones
y contaminación del tablero; la Opción C (asiento consolidado) exige
esquema de reportes nuevo (fuera de alcance). **Impacto operativo**: el
negocio piloto debe cuadrar caja de mesas aparte (la cuenta digital lista
pagos por método y propinas). La integración contable es el pendiente #1
antes del deploy GENERAL del módulo.

## Migración 039 y predeploy
`scripts/predeploy-039-restaurante-mesas.mjs` en el runner DESPUÉS de 038
(orden 032→…→038→039; `railway.toml` sin tocar). Validado en 2 ×
PostgreSQL 18.4: runner completo sobre base en 038 (038 no-op, 039 aplica),
`_check`, idempotencia script y SQL, verificación anti-backfill (3 tablas
vacías + índice único o aborta), `_down` en base desechable (pierde
cuentas/items/pagos capturados y quita 'restaurante' del CHECK) y
re-aplicación.

## Pruebas
- Suite C: **19/19 en ambas bases PG18.4** (15 originales + 4 de
  concurrencia ampliada).
- Regresión en la rama (0 fallos): Central de Operaciones 25/25 · red por
  negocio 20/20 · P0 29/29 · pagos multiempresa 48/48 · tiempo-real 26/26 ·
  universos D.1 15/15 · carrera inserción 2/2.
- Build Docker: exitoso.

## Riesgos
- El bloqueo de caja/reportes es el riesgo operativo principal — mitigado
  con la advertencia y el gating por módulo (solo pilotos elegidos).
- Plantilla física del ticket sin campos de mesa (genérica) hasta ajustar
  print-agent.
- `prompt()`/`confirm()` en la UI de mesas: aceptable para piloto interno.

## Estrategia de piloto (NO ejecutada)
Selección: negocio con servicio en mesa real, pocas mesas, dueño
involucrado, impresora compatible, personal capacitable, respaldo manual
posible, horario controlado. Etapas: activar módulo SOLO al piloto →
`restaurante_num_mesas` → métodos de pago → 3–5 mesas de prueba → abrir
cuenta → comanda inicial → adicional → dividir → dos métodos de pago →
cerrar → confirmar impresión (o su omisión) → confirmar la ADVERTENCIA de
caja con el dueño → auditoría → rollback operativo (desactivar módulo =
las rutas responden 403, sin tocar datos) → ampliar gradualmente.

## Deploy (cuando se autorice) y rollback
Backup → `railway up --ci` desde worktree enlazado en esta rama → predeploy
corre solo (032–038 no-op, 039 aplica y verifica vacías) → smoke: health,
log del predeploy, `restaurante_*` vacías, módulo NO activo para nadie,
rutas 401 sin sesión, regresión visual de Nonna Maye. Rollback: redeploy
del deployment anterior (039 aditiva y sin backfill; `_down` solo con causa
técnica confirmada).

## Pendientes
1. **Integración caja/reportes** (bloqueante para deploy GENERAL; no para
   piloto con advertencia).
2. Plantilla física del ticket con mesa/personas/tipo en print-agent.
3. Selección del negocio piloto (Carnitas Moreno es candidato SOLO si
   confirma servicio en mesa — hoy ni siquiera activó su cuenta).
4. Roles finos mesero/caja (arquitectura de roles futura).
