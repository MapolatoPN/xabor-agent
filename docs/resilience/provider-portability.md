# Portabilidad de proveedor

## Pregunta

Si mañana hubiera que levantar Xabor fuera de Railway, en cuánto tiempo y
tropezando con qué.

## Lo que ata a Railway hoy

| Cosa | ¿Ata? | Detalle |
|---|---|---|
| `Dockerfile` | **no** | `node:20-slim` estándar, nada del proveedor |
| `railway.toml` | poco | builder, healthcheck y pre-deploy; hay equivalentes |
| Variables `RAILWAY_*` | **sí, leve** | se leen para telemetría y URLs públicas |
| `DATABASE_URL` | no | cadena estándar de Postgres |
| Dominio interno | **sí** | `xabor-agent.railway.internal` |
| Volúmenes | no | la aplicación no escribe estado en disco |
| Comando de pre-despliegue | **sí, importante** | ahí corren las migraciones |

## El detalle que más duele

Las migraciones no se aplican solas al arrancar. Corren en el
`preDeployCommand` de `railway.toml`, que apunta a
`scripts/predeploy-run-032-033.mjs`. El nombre está congelado; la fuente de
verdad es su lista `SCRIPTS`, que ya llega hasta `043-impresion-edge`.

**Consecuencia:** en otro proveedor hay que reproducir ese paso explícitamente
como hook de despliegue, o las tablas no existen y el arranque falla. Y para
añadir una migración nueva hay que meterla en esa lista, no cambiar el toml.

No hay tabla de control de migraciones: cada script decide por sí mismo si ya
se aplicó (043 lo hace mirando si existen sus cinco tablas). Es simple y
funciona, pero significa que el orden lo garantiza la lista, no la base.

## Cloudflare

Comprobado en vivo: `https://xabor.mx/` no devuelve bytes estables. Cloudflare
inyecta su script de protección de correo con un token que cambia en cada
petición (56 040 → 57 334 bytes). Es un tercer dominio de fallo y hace que
verificar "el HTML servido coincide con el commit" por hash deje de funcionar.

Para verificar qué commit sirve producción conviene usar una señal del
backend — por ejemplo, que una ruta nueva conteste 401 en vez de 404 — en vez
de comparar el HTML.

## Portabilidad de la base (Parte 58)

Revisado: se usan `gen_random_uuid()` (pgcrypto, presente en cualquier Postgres
13+), JSONB, índices parciales y triggers propios. **No hay extensiones
exóticas ni procedimientos que impidan mover la base.** Cualquier Postgres 15+
gestionado la acepta con un `pg_restore`.

## Veredicto

El contenedor **ya es portable**. Lo que falta para levantarlo en otro sitio:

1. reproducir el hook de pre-despliegue de migraciones;
2. sustituir el dominio interno por configuración;
3. tolerar la ausencia de variables `RAILWAY_*`;
4. decidir dónde vive Postgres.

Ninguno es un rediseño. Es media jornada de trabajo más la decisión de la base.
