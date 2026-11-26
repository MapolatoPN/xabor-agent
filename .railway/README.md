# Railway configuration

## Xabor: alcance y revisión

La configuración está limitada por nombre e ID a `honest-tenderness / production`.
Rechaza staging y otros proyectos antes de construir el plan. Se importaron los
recursos existentes; PostgreSQL y su volumen de 1 GB deben permanecer sin cambios.
Todas las credenciales se declaran con `preserve()`: sus valores permanecen en Railway.

La fuente del servicio se fija a la rama y al commit del checkout que genera el
plan. No hay un SHA antiguo incrustado en este archivo que pueda revertir otra
publicación. En GitHub Actions se admite `GITHUB_HEAD_REF` cuando el checkout es
el commit de integración; fuera de ese contexto se necesita una rama seleccionada.

Este archivo sustituye `railway.toml`: conserva Dockerfile, predeploy, salud en
`/health` (60 segundos) y tres intentos de reinicio, con la política
`ON_FAILURE` predeterminada de Railway. El tipo queda implícito porque la
configuración devuelta por Railway omite ese valor por defecto; declararlo
explícitamente genera una diferencia repetida aunque no cambie la política.

En Windows usa `npm run railway:plan` y `npm run railway:apply`. El wrapper invoca
el ejecutable oficial y le da al SDK su ruta real para comprobar la versión;
no modifica el SDK ni omite la comprobación. Si la instalación es distinta de
la habitual de npm, define `RAILWAY_CLI_BINARY` con la ruta de `railway.exe`.

Para inicializar el destinatario de los avisos, define temporalmente
`XABOR_LEADS_NOTIFICATION_EMAIL` en el proceso que genera el plan. El archivo
no contiene esa dirección; después `preserve()` conserva la variable
`LEADS_NOTIFICATION_EMAIL` ya cargada en Railway.

Antes de aplicar: confirmar `railway status`, tener el código comprometido y
publicado en la rama revisada, generar `npm run railway:plan -- --out <archivo>`
y revisar **todos** los cambios. El plan de esta migración debe modificar solo
`xabor-agent`: código aprobado, destinatario y ajustes de despliegue. Rechazar
cualquier borrado, cambio de credenciales, almacenamiento, base de datos o
servicio ajeno. No usar `--confirm-destructive`.

Aplicar únicamente el plan revisado con `npm run railway:apply -- --plan <archivo>
--yes`, dentro de la autorización del dueño. El CLI comprueba que no haya cambiado
el entorno ni el árbol `.railway`. Después verificar versión, salud y un nuevo
plan sin cambios. No volver a importar ni aplicar a ciegas una configuración
generada en otro entorno.

[Documentación de la migración](https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code).

## Referencia del CLI

This project defines its Railway infrastructure in code.

```txt
.railway/railway.ts
```

Use this file to describe the Railway project you want: services, databases, buckets, custom domains, replicas, groups, and environment variables.

The TypeScript file imports `railway/iac`. Install the SDK from the repository root:

```bash
npm install railway
```

## Common commands

Create the configuration files:

```bash
railway config init
```

Import an existing Railway project into code:

```bash
railway config pull
```

Preview what Railway would change:

```bash
railway config plan
```

Apply the planned changes:

```bash
railway config apply
```

## Notes

- `railway config plan` is safe and does not change Railway.
- `railway config apply` previews changes and asks before applying unless you pass `--yes`.
- Destructive changes in non-interactive or agent sessions require `railway config apply --confirm-destructive` after reviewing the plan.
- CI should pin a plan (`railway config plan --out railway-plan.json`) and apply that file on merge (`railway config apply --plan railway-plan.json --yes --confirm-destructive`) so the reviewed change set is what lands. On GitHub Actions, use https://github.com/railwayapp/config.
- Services already managed by `railway.json` must be migrated before `.railway/railway.ts` can manage them.
- Keep one `.railway` file for the whole project. A named `export const partial` (or `PARTIAL` / `const Partial`) is a last resort for separate repos that cannot share that file. Do not add it unless omit=delete across repos is a blocker.
- Use `replicas` for scaling; advanced placement can still specify region names.
- Use `group("Name", [resources])` to keep large projects organized on the Railway canvas.
- Secrets imported from Railway are rendered as `preserve()` so existing values are retained without writing secret values to source. Use `railway config pull --omit-preserved-variables` for a smaller import. `railway config pull --include-variables` decrypts and inlines non-sealed values (including secrets that were never sealed).
- `railway config migrate` finds every `railway.json` / `railway.toml` in the repository and writes them into this one file.
