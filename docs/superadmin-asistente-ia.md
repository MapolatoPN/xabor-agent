# Superadmin — Asistente IA (Vision + giro)

**Estado:** implementado y probado en local (rama `superadmin-vision-giro-clean`), SIN desplegar.

## Qué resuelve

Hasta este cambio, prender Vision o configurar el giro de un negocio requería
SQL manual contra la base de producción. La ficha del negocio en Superadmin
ahora tiene la sección **Asistente IA** con:

- **Switch Vision ON/OFF** — administra `configuracion.vision_imagenes`.
- **Selector de giro** — administra `configuracion.giro`, con catálogo
  sugerido (restaurante, floreria_eventos, pasteleria, boutique, ferreteria,
  retail, servicios) y opción **"Otro…"** con slug personalizado.
- **Estado read-only** de WhatsApp (`integraciones_canal`) y del módulo
  `chat_imagenes` — contexto para decidir, no editable aquí.

## Decisiones de diseño

1. **Sin fuente de verdad nueva.** La UI lee y escribe las MISMAS claves de
   `configuracion` que el motor de Vision consume por turno
   (`src/agent/vision.js`), así que el cambio surte efecto de inmediato y
   sin deploy. Sin fila de `vision_imagenes`: **OFF** (fail closed, idéntico
   a `visionHabilitada()`).
2. **El catálogo de giros es sugerencia, no ENUM.** Un slug limpio nuevo
   (`^[a-z][a-z0-9_]{1,39}$`) es válido; el motor cae a core universal para
   giros que no reconoce. Giro vacío borra la fila (sin filas fantasma).
3. **Mismo patrón que estado/plan.** `requireSuperadmin`, transacción con
   `FOR UPDATE` (concurrencia serializada, cero filas duplicadas por el
   upsert `(negocio_id, clave)`), y auditoría con el mecanismo existente
   (`registrarAuditoriaPlataforma`, acción `cambiar_asistente_ia`, estados
   anterior/nuevo).
4. **El endpoint PATCH solo lee `vision` y `giro`** del body — claves
   arbitrarias se ignoran; jamás escribe configuraciones ajenas.
5. **La UI nunca miente.** Candado anti doble click y, ante cualquier error
   del backend o de red, recarga del estado real antes de repintar.
6. **Sin bulk "activar en todos"** — decisión V1: negocio por negocio.

## Piezas

- `src/services/database.js`: `obtenerAsistenteIaNegocio`, `esGiroValido`,
  `actualizarAsistenteIaNegocio`.
- `src/server.js`: `GET/PATCH /api/superadmin/negocios/:id/asistente-ia` +
  `GIROS_SUGERIDOS`.
- `panel/superadmin.html`: card "Asistente IA" + `cargarAsistenteIA` /
  `pintarAsistenteIA` / `cambiarVisionIA` / `guardarGiroIA`.

## Pruebas

`test/fase-superadmin-asistente-ia.mjs` — 21 casos (18 del gate + 4
adversariales): default OFF, upsert sin duplicados, giro
visible/actualizable/limpiable, ON sin giro válido (modo universal), tenant
isolation, roles bloqueados, valores inválidos 400, refresh estable,
read-only real, contratos UI (no-miente, candado), concurrencia con PATCH
opuestos, sin sesión 401, negocio inexistente 404, claves arbitrarias
ignoradas, auditoría con actor. Validación visual en vivo con servidor
local: card renderiza el estado real y el switch OFF→ON responde con
feedback correcto.
