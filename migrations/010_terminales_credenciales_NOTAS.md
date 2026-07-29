# Migración 010 — Credenciales de terminal (`terminales.token_hash`)

Rama: `feature/multitenancy-operativo`
Worktree: `C:/xabor-multitenancy-operativo`

## Contexto

Primer commit de la fase de autenticación del print-agent por negocio y
terminal (diseño aprobado, ver reporte previo de esta fase). Esta
migración **solo** prepara el esquema — no toca `server.js`,
`orderManager.js`, `print-agent.js`, el panel, rutas API, WebSocket, ni
`configuracion`. Ningún token real se genera ni se asigna aquí.

## Auditoría previa del esquema de `terminales`

`terminales` existe desde la migración 003 y **no tiene ninguna
referencia en código de aplicación** (confirmado por búsqueda en todo
`src/` y `panel/`). Esquema antes de esta migración:

```sql
CREATE TABLE terminales (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id  UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,
  codigo       TEXT NOT NULL,
  activo       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sucursal_id, nombre),
  UNIQUE (sucursal_id, codigo)
);
```

`created_at`/`updated_at` y su trigger `set_updated_at` (disparado
`BEFORE UPDATE`) **ya existían** desde 003 — confirmado antes de escribir
esta migración, no se duplican ni se vuelven a crear con lógica nueva.

**No existe ningún mecanismo de versionado de esquema** en este
proyecto (sin tabla `schema_migrations` ni equivalente) — las
migraciones se aplican y rastrean manualmente por convención de nombre
de archivo. No hay nada que actualizar en ese sentido.

## Columnas agregadas

| Columna | Tipo | Nullable | Default | Motivo |
|---|---|---|---|---|
| `token_hash` | `TEXT` | Sí | ninguno | Hash del token de la terminal (nunca el token en claro). Nullable para permitir migración gradual — una terminal puede existir antes de tener credencial asignada. |
| `tipo` | `TEXT` | No | `'impresora'` | Clasifica el rol de la terminal. Sin `ENUM` ni `CHECK IN (...)` — mismo criterio que `canal` en `integraciones_canal` (008): agregar un tipo nuevo (`punto_venta`, `kiosko`, etc.) no debe requerir otra migración. |
| `ultima_conexion` | `TIMESTAMP` | Sí | ninguno | Última autenticación exitosa. Se escribirá explícitamente desde la aplicación en el momento exacto de un login válido — deliberadamente **sin trigger**, para no confundirla con cualquier otro `UPDATE` administrativo de la fila. |

`negocio_id` **no se agregó** — se sigue resolviendo exclusivamente vía
`terminales.sucursal_id → sucursales.negocio_id`, sin denormalizar,
igual que ya hace `integraciones_canal` con su columna `sucursal_id`
opcional.

## Índice único parcial

```sql
CREATE UNIQUE INDEX idx_terminales_token_hash_unique
  ON terminales (token_hash)
  WHERE token_hash IS NOT NULL;
```

Garantiza a nivel de base de datos — no solo por la baja probabilidad de
colisión de un hash criptográfico — que dos terminales nunca puedan
compartir accidentalmente el mismo `token_hash` (lo que permitiría que
una terminal se autenticara con la identidad de otra). Es parcial porque
la mayoría de las filas seguirán con `token_hash IS NULL` durante la
migración gradual, y una restricción no-parcial habría sido
técnicamente equivalente (Postgres permite múltiples `NULL` en una
`UNIQUE`), pero el índice parcial deja la intención explícita y
documentada, mismo patrón que el índice parcial ya existente de
`integraciones_canal.sucursal_id` (008).

## Trigger `updated_at`

Ya existía desde 003. Esta migración lo reafirma de forma idempotente
(`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`) únicamente por consistencia
con el resto del archivo — no crea una segunda función, `set_updated_at()`
sigue siendo la única definida (003), y sigue siendo compartida por
`negocios`, `sucursales`, `usuarios`, `usuario_sucursales`,
`usuario_negocios` e `integraciones_canal`.

## Rollback

`010_terminales_credenciales_down.sql` elimina únicamente las tres
columnas nuevas y el índice único parcial. No toca `created_at`,
`updated_at`, el trigger `set_updated_at` ni la función — todos
pertenecen a la migración 003. **Aborta si ya existe algún
`token_hash` real (no NULL)**, para no invalidar en silencio
credenciales de terminal ya emitidas.

## Alcance de esta fase

- No se tocó `src/server.js`, `src/orders/orderManager.js`,
  `print-agent.js`, `panel/index.html`, ni ninguna ruta API.
- No se generó ningún token real ni se sembró ningún dato.
- No se ejecutó ninguna migración contra Railway/producción — todo se
  probó contra Postgres efímero local.
- No se agregó ninguna dependencia nueva.
