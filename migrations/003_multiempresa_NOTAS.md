# Migración 003 — Multiempresa (estructura base)

Rama: `feature/multitenancy-fase-0`

## Archivos

| Archivo | Propósito |
|---|---|
| `003_multiempresa.sql` | Migración up: crea `negocios`, `sucursales`, `terminales`, `usuarios`, `usuario_sucursales`, más la función `set_updated_at()` y sus triggers |
| `003_multiempresa_down.sql` | Rollback: elimina triggers, función y las 5 tablas, en ese orden |
| `003_multiempresa_seed.sql` | Seed idempotente: Nonna Maye / nonna-maye / Piedras Negras / Caja principal (codigo: caja-principal) |
| `003_check_multiempresa.sql` | Validación de solo lectura post-migración |

## Orden de ejecución

1. `001_memory_engine.sql` y `002_campanas.sql` ya deben estar aplicadas (no se tocan en esta migración).
2. `003_multiempresa.sql` — crea las tablas nuevas, la función `set_updated_at()` y los triggers `BEFORE UPDATE` en cada una de las 5 tablas.
3. `003_multiempresa_seed.sql` — inserta el negocio/sucursal/terminal base (idempotente, se puede correr varias veces sin duplicar filas).
4. `003_check_multiempresa.sql` — valida estructura, reglas de borrado, triggers y datos (solo lectura, no modifica nada).

## `updated_at`

Cada tabla tiene un trigger `BEFORE UPDATE` (`set_updated_at`) que asigna
`NEW.updated_at = NOW()` en cada edición, usando una única función
reutilizable `set_updated_at()`. `DEFAULT NOW()` solo cubre el valor al
insertar; el trigger es lo que lo mantiene correcto en updates posteriores.

## Reglas de borrado (`ON DELETE`)

- `sucursales.negocio_id → negocios.id`: **RESTRICT** — un negocio con
  sucursales no se puede eliminar físicamente; se desactiva con `activo = false`.
- `usuarios.negocio_id → negocios.id`: **RESTRICT** — mismo criterio, evita
  borrar en cascada las cuentas de usuario de un negocio.
- `terminales.sucursal_id → sucursales.id`: **CASCADE** — una terminal no
  tiene sentido sin su sucursal.
- `usuario_sucursales.usuario_id → usuarios.id`: **CASCADE** — tabla puente,
  el acceso no tiene sentido sin el usuario.
- `usuario_sucursales.sucursal_id → sucursales.id`: **CASCADE** — mismo
  criterio, el acceso no tiene sentido sin la sucursal.

## `terminales.codigo`

Se agregó `codigo TEXT NOT NULL` con `UNIQUE (sucursal_id, codigo)`, como
identificador estable de la terminal (independiente de `nombre`, que es
solo la etiqueta visible). El seed usa `codigo: caja-principal` para la
terminal `Caja principal`.

## Rollback

Ejecutar `003_multiempresa_down.sql`. Orden interno:

1. Elimina los 5 triggers `set_updated_at`.
2. Elimina la función `set_updated_at()`.
3. Elimina las tablas en orden FK-safe: `usuario_sucursales`, `usuarios`,
   `terminales`, `sucursales`, `negocios`.

No afecta ninguna otra tabla ni función del sistema.

## Alcance de esta fase

- No se agregó `negocio_id` a `pedidos`, `clientes`, `menú`, `caja` ni
  ninguna otra tabla existente.
- No se agregó `rol`, `password_hash`, JWT ni ningún cambio de
  autenticación — `usuarios` sigue sin esas columnas; quedará para una
  migración separada de login/autenticación.
- Ninguna migración de esta fase fue ejecutada contra Railway/producción.
  Todo el trabajo hasta ahora es solo archivos SQL en el working tree.
