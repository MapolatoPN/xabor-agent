# Lista única: Tienda en línea = WhatsApp = Rappi (octubre 2026)

Decisión de Mario del 2026-10-07: lo publicado en la Tienda en línea es lo que
ofrece el bot de WhatsApp (carta, formulario y validación del pedido) y lo que
sube a Rappi. Si las listas difieren, **manda la tienda**.

- El código (`src/services/publicacionUnica.js`) hace que toda publicación —desde
  la tienda o desde «Productos para WhatsApp»— cambie las dos tablas en la misma
  sentencia. Rappi lee directamente la tienda.
- Lo que el código no arregla es el desacuerdo que ya existe en la base: eso lo
  empareja este script, una sola vez, **después** del despliegue.

Scripts sobre la base de **producción**. Hacen simulacro por omisión
(transacción que termina en ROLLBACK) y solo guardan con `--aplicar`. Antes de
guardar escriben el estado anterior en `C:\xabor-respaldos\lista-unica-2026-10\`
(otro directorio con `--respaldo=<dir>`).

Conexión (desde `C:\xabor-agent`, que es donde está enlazado `railway`):

```powershell
$pg = railway variables --service Postgres --json | Out-String | ConvertFrom-Json
$env:DATABASE_URL = $pg.DATABASE_PUBLIC_URL   # nunca imprimirla
```

## Orden

| Paso | Qué | Cómo |
|---|---|---|
| 1 | Desplegar el código de la lista única | lo autoriza Mario |
| 2 | Ver qué cambiaría en WhatsApp | `node scripts/ops/lista-unica-2026-10/alinear-whatsapp-con-tienda.mjs` |
| 3 | Emparejar | lo mismo con `--aplicar` |
| 4 | Revisar otra vez las imágenes del menú de WhatsApp | Menú › Productos para WhatsApp: la carta cambió, y hasta confirmar el bot manda el menú en texto |
| 5 | Subir el menú a Rappi | botón «Subir menú» del panel de cada negocio con Rappi |

`--negocio=mapolato-obispado,mapolato-acuna` limita el emparejamiento. El script
aborta si un negocio con carta de WhatsApp tiene la tienda vacía: el bot se
quedaría sin carta y dejaría de contestar (`--forzar` para hacerlo de todos modos).

## Reversa

```powershell
node scripts/ops/lista-unica-2026-10/revertir.mjs C:\xabor-respaldos\lista-unica-2026-10\<alinear-ANTES-…>.json            # simulacro
node scripts/ops/lista-unica-2026-10/revertir.mjs C:\xabor-respaldos\lista-unica-2026-10\<alinear-ANTES-…>.json --aplicar
```

Devuelve WhatsApp a su lista anterior (publicado, origen y autor; la fecha la
fija el trigger). Mientras siga desplegado el código de la lista única, el
siguiente cambio en la tienda de un producto lo vuelve a igualar: revertir del
todo es también desplegar el binario anterior.
