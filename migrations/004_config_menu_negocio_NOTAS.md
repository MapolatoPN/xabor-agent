# Migración 004 — Config y menú multiempresa (Fase 1)

Rama: `feature/multitenancy-fase-0`

## Archivos

| Archivo | Propósito |
|---|---|
| `004_config_menu_negocio.sql` | Migración up: agrega `negocio_id` a `configuracion`, `menu_categorias`, `menu_productos`, `menu_modificadores_grupos`, `menu_modificadores_opciones`; backfillea a `nonna-maye`; cambia `configuracion` a PK `(negocio_id, clave)` y `menu_productos` a `UNIQUE (negocio_id, codigo)` |
| `004_config_menu_negocio_down.sql` | Rollback con guardas de seguridad que abortan si revertir perdería o corrompería datos |
| `004_check_config_menu_negocio.sql` | Validación de solo lectura post-migración |

## Orden de ejecución

1. `003_multiempresa.sql` ya debe estar aplicada (existe la tabla `negocios` y el negocio `nonna-maye`).
2. `004_config_menu_negocio.sql` — agrega `negocio_id`, backfillea, endurece el esquema.
3. `004_check_config_menu_negocio.sql` — valida columnas, FKs, índices, restricciones únicas, asignación completa a `nonna-maye` y ausencia de relaciones cruzadas en el árbol de menú.

## Secuencia interna del `up` (por diseño, no reordenable)

1. Verificar que exista exactamente 1 negocio con `slug='nonna-maye'` — aborta con `RAISE EXCEPTION` antes de tocar cualquier dato si no.
2. Agregar `negocio_id UUID` nullable a las 5 tablas.
3. Backfill: asignar todo lo existente al UUID de `nonna-maye`, solo donde `negocio_id IS NULL` (reejecutable sin duplicar trabajo).
4. Verificar que no quede ningún `NULL` — aborta si lo hay.
5. `SET NOT NULL` en las 5 columnas.
6. Agregar FK hacia `negocios(id) ON DELETE RESTRICT` (mismo criterio que Fase 0: no se borra en cascada la config/menú de un negocio; se desactiva el negocio, no se elimina físicamente).
7. Crear los 5 índices por `negocio_id`.
8. Cambiar las restricciones únicas de `configuracion` y `menu_productos` (ver abajo).

Los bloques `DO $$ ... $$` que agregan FKs y restricciones únicas consultan `pg_constraint` (y `pg_attribute` para comparar por columnas, no por nombre asumido) antes de actuar, porque Postgres no soporta `ADD CONSTRAINT IF NOT EXISTS`. Esto hace que la migración completa sea segura de re-ejecutar.

## Restricciones únicas que cambian

- `configuracion`: `PRIMARY KEY (clave)` → `PRIMARY KEY (negocio_id, clave)`.
- `menu_productos`: `UNIQUE (codigo)` → `UNIQUE (negocio_id, codigo)`.
- `menu_categorias`, `menu_modificadores_grupos`, `menu_modificadores_opciones`: no tenían restricciones de nombre/código que cambiar; ya admiten valores repetidos.

## No incluido en esta migración (a propósito)

- **Sin triggers ni lógica compleja.** Esta migración solo agrega columnas, backfillea y ajusta restricciones. No hay ningún mecanismo automático en la base de datos que mantenga sincronizado `negocio_id` entre padre e hijo del árbol de menú.
- **Integridad del árbol de menú — pendiente para la siguiente etapa de código** (cambios en `src/services/database.js`, fuera del alcance de esta tarea):
  - el `negocio_id` de un **producto** se derivará de su **categoría** (`menu_categorias.negocio_id` vía `categoria_id`);
  - el `negocio_id` de un **grupo de modificadores** se derivará de su **producto** (`menu_productos.negocio_id` vía `producto_id`);
  - el `negocio_id` de una **opción de modificador** se derivará de su **grupo** (`menu_modificadores_grupos.negocio_id` vía `grupo_id`);
  - en ningún caso se aceptará `negocio_id` libremente desde el frontend o el body de una request — siempre se deriva del padre en el momento de crear el registro, para que nunca pueda desincronizarse del árbol.
- `004_check_config_menu_negocio.sql` sí valida esta consistencia (sección 8), pero solo la **detecta** — no la corrige ni la previene. La prevención real llega con el cambio de código de la siguiente etapa.

## Rollback

`004_config_menu_negocio_down.sql` primero corre tres guardas de seguridad y **aborta sin modificar nada** si alguna falla:

1. Hay más de un `negocio_id` distinto con datos en estas 5 tablas (revertir perdería la separación multiempresa).
2. Hay claves repetidas en `configuracion` que impedirían restaurar `PRIMARY KEY (clave)`.
3. Hay códigos repetidos en `menu_productos` que impedirían restaurar `UNIQUE (codigo)`.

Si las tres guardas pasan, revierte en este orden:

1. Elimina las FKs nuevas.
2. Elimina los índices nuevos.
3. Restaura `PRIMARY KEY (clave)` en `configuracion`.
4. Restaura `UNIQUE (codigo)` en `menu_productos`.
5. Elimina `negocio_id` de las 5 tablas.

El rollback es reejecutable: si ya se aplicó (las columnas `negocio_id` ya no existen), la primera guarda se salta explícitamente y el resto de los pasos son no-ops seguros (`IF EXISTS` / recreación idéntica).

## Alcance de esta tarea

- Solo se crearon los 4 archivos de esta migración. No se modificó `src/services/database.js`, `src/server.js`, `panel/index.html`, autenticación, cachés, WhatsApp, voz, pedidos, impresión, SAT, Rappi ni Clip.
- Ninguna migración de esta fase fue ejecutada contra Railway/producción — todo el trabajo es archivos SQL en el working tree, validados en un Postgres efímero local (ver validación aislada).
