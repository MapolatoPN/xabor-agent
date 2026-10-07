# Depuración de negocios y superadmin (octubre 2026)

Scripts de operación sobre la base de **producción**. Todos hacen simulacro por
omisión (transacción que termina en ROLLBACK) y solo guardan con `--aplicar`.
Antes de guardar escriben el estado anterior en
`C:\xabor-respaldos\depuracion-2026-10\` (otro directorio con `--respaldo=<dir>`).

Conexión (desde `C:\xabor-agent`, que es donde está enlazado `railway`):

```powershell
$pg = railway variables --service Postgres --json | Out-String | ConvertFrom-Json
$env:DATABASE_URL = $pg.DATABASE_PUBLIC_URL   # nunca imprimirla
```

## Fase 2 — orden

| Paso | Qué | Cómo |
|---|---|---|
| 1 | Contener las cuentas @test.local (contraseñas públicas en el repo; una era superadmin) | `node scripts/ops/depuracion-2026-10/01-contener-cuentas-prueba.mjs` → revisar → `--aplicar` |
| 2 | Desplegar la migración 116 y el binario con el segundo factor | lo autoriza Mario; ver «Despliegue» |
| 3 | Mover `mario@xabor.mx` a mapolato-obispado como admin | `node scripts/ops/depuracion-2026-10/02-mover-superadmin-a-obispado.mjs` → revisar → `--aplicar` |
| 4 | Entrar a `https://xabor.mx/superadmin` y dar de alta el segundo factor | contraseña de siempre → QR en la app → código |

El 02 aborta si hay otro superadmin activo además de `mario@xabor.mx`: el 01 va
antes. Entra directo a `/superadmin`, no a `/app`: abrir el panel de un negocio
en un navegador más puede imprimir comandas si el Edge no se hace cargo.

## Reversa

```powershell
node scripts/ops/depuracion-2026-10/revertir.mjs C:\xabor-respaldos\depuracion-2026-10\<archivo-ANTES>.json            # simulacro
node scripts/ops/depuracion-2026-10/revertir.mjs C:\xabor-respaldos\depuracion-2026-10\<archivo-ANTES>.json --aplicar
```

- Del 02: devuelve el negocio de origen y las membresías tal como estaban.
- Del 01: reactiva las cuentas @test.local. **Ojo:** sus contraseñas son públicas.
- Segundo factor perdido (teléfono): `node scripts/superadmin-2fa-reiniciar.mjs mario@xabor.mx --aplicar`;
  en el siguiente ingreso pide contraseña y un QR nuevo.
- Quitar el segundo factor por completo: desplegar el binario anterior y, si
  hace falta, `migrations/116_superadmin_2fa_down.sql`.

## Despliegue

La 116 corre sola en el predeploy (`scripts/predeploy-116-superadmin-2fa.mjs`,
dentro de `predeploy-run-032-033.mjs`): una tabla vacía y una columna nullable;
aborta si cambia un superadmin o una fila de la bitácora.

Producción no despliega desde `main` (ver CLAUDE.md y la nota de despliegue
vigente): se empuja a la rama que sigue Railway y se lanza
`railway redeploy --yes --from-source` desde `C:\xabor-agent`. Huella para
verificar que llegó: `Invoke-WebRequest https://xabor.mx/superadmin` debe
contener `id="segundo-factor"`.
