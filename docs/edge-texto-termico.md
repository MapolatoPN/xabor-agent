# Texto para la térmica en el Edge

Rama `fix/edge-texto-termico`, sobre `prod/mesero-shadow-v3` (434940e).
Cambia **un solo archivo del agente**: `edge/renderers/escpos.js`.

## Qué pasaba

El renderer del Edge convierte el texto en bytes con
`Buffer.from(texto, 'latin1')`. Eso no descarta lo que no es latin1: se queda
con el byte bajo de cada carácter. Comprobado el 15-oct-2026 con
`renderComanda` y `persona {numero: 1, nombre: 'Ana'}`:

| Se escribe | Llegaba a la impresora |
|---|---|
| `Orden 1 — Ana` (raya U+2014) | `ORDEN 1 \x14 ANA`: 0x14 es DC4, un código de control |
| comillas “ ” (iPhone) | 0x1C / 0x1D: FS y GS, con los que empiezan los comandos ESC/POS |
| `…` | `&` |
| un emoji | dos bytes sueltos, p. ej. `=` y un salto de línea |

El nombre de cada persona y las notas los teclea el mesero, así que cualquiera
de estos puede llegar al papel.

## Qué cambia en el papel

`textoTermico()` (en `escpos.js`) sanea todo texto antes de convertirlo en
bytes. `texto()`, `columnas()` y `bloque()` lo usan, y por ellas pasa todo lo
que imprimen la comanda, la cuenta, la precuenta, la cancelación y la prueba
de impresora.

- Las rayas (U+2010–U+2015 y el signo menos) se imprimen como `-`.
  «Orden 1 — Ana» sale `ORDEN 1 - ANA`.
- Las comillas tipográficas se imprimen como comillas rectas y `…` como `...`.
- Los acentos que algunos teclados mandan descompuestos («e» + acento) se
  recomponen: salen como «é», no se pierden.
- Tabuladores y saltos de línea dentro de un texto se vuelven espacio.
- Se quita todo lo demás que no sea latin1 imprimible: emojis y caracteres de
  control.

El texto en ASCII o latin1 (acentos, ñ, ¿, ¡, ·) sale idéntico, byte por byte.
Se sanea **antes** de medir: `columnas` alinea el importe al borde y `bloque`
envuelve al ancho del papel con el texto ya saneado.

`tituloPersona` (en `personas.js`) **no cambia**. El servidor usa esa misma
función para etiquetar la nota que va a los Edge viejos, y el Edge la compara
para quitar esa etiqueta. Si cambiara de un solo lado, la nota saldría con la
etiqueta repetida.

## Qué NO cambia

- El servidor. Ningún archivo de `src/` cambia y Railway no necesita
  despliegue. El servidor no importa `escpos.js`.
- El QR de autofactura: es una imagen y no pasa por el texto.
- Los comandos ESC/POS (negritas, tamaño, corte): son bytes aparte.

## Prueba

`node test/fase-edge-texto-termico.mjs`: sin Postgres, 8 casos. Con el código
anterior fallan los 8. Con el arreglo pasan los 8.

Mordida, con cada garantía desactivada por separado:

| Se desactiva | Casos que caen |
|---|---|
| `texto()` no sanea | 5 |
| `columnas()` no sanea | 5, 6 |
| `bloque()` envuelve sin sanear antes | 8 |
| las rayas no se convierten | 1, 2, 4, 5, 7 |
| sin filtro latin1 imprimible | 2, 5, 6, 7 |
| sin recomponer acentos | 7 |
| comillas sin convertir | 5, 7 |
| `…` sin convertir | 5, 7 |
| tabuladores y saltos sin convertir | 7 |

## Llevarlo a las PCs de Obispado y Acuña

Un despliegue de Railway **no** cambia el papel. El renderer corre en la PC de
cada sucursal, en el servicio de Windows «Xabor Edge» (`XaborEdge`), que no se
actualiza solo. Se reemplaza **solo `escpos.js`**: exporta todo lo que
exportaban las dos versiones que han existido (`6b4960a` del 9-ago y `db10e61`
del 24-sep), así que el resto del Edge instalado no se toca.

Conviene hacerlo fuera de la hora pico. Al reiniciarse, el servicio espera a
que termine la impresión en curso. Lo que llegue mientras tanto se queda en
la cola local y sale al arrancar.

### Paso único, en cada PC

Abrir **PowerShell como administrador** y pegar el bloque completo. Va entre
`& { ... }` a propósito: así se ejecuta como una sola orden, y si una
comprobación falla se detiene antes de tocar algo. Si se pega línea por línea,
las líneas siguientes se ejecutarían aunque una comprobación hubiera fallado.

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $esperado = '4895A88C70CA2187F21E04DEED532205ECC87E8F569D58BB041207FA01A7863B'
  $conocidas = @{
    '3FDE90AA37418FDE4DD2CA9C80623A76E804B5CFB30D6349F284ECA36EB0C79B' = 'db10e61 (24-sep, con QR)'
    '95D7714B02E5D3372000B4806AEBC22D0C00D7E1226A40513AA57C403EEEEC0E' = 'db10e61 (24-sep, con QR, CRLF)'
    'C72A2A6AF83291F95570408F6B639E45F9869327463058BA0C75C52DE5121764' = '6b4960a (9-ago)'
    'E2052ED50D0F3D579AC2919FCAFD651B8980A0439CA15378822E109AFEE05CE7' = '6b4960a (9-ago, CRLF)'
  }
  $svc = Get-CimInstance Win32_Service -Filter "Name='XaborEdge'"
  if (-not $svc) { throw 'Esta PC no tiene el servicio XaborEdge. No se toco nada.' }
  if ($svc.PathName -notmatch '^"?([^"]+?\.exe)') { throw "Ruta del servicio no reconocida: $($svc.PathName)" }
  $base = Split-Path $Matches[1]
  $dir  = Join-Path $base 'app\edge\renderers'
  $dest = Join-Path $dir 'escpos.js'
  $actual = (Get-FileHash $dest -Algorithm SHA256).Hash
  if ($actual -eq $esperado) { Write-Host 'Esta PC ya tiene el arreglo. No se toco nada.'; return }
  if (-not $conocidas.ContainsKey($actual)) { throw "escpos.js instalado no es una version conocida ($actual). No se toco nada." }
  Write-Host "Instalado hoy: $($conocidas[$actual]) en $dir"

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $nuevo = Join-Path $env:TEMP 'escpos-texto-termico.js'
  Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/MapolatoPN/xabor-agent/refs/heads/fix/edge-texto-termico/edge/renderers/escpos.js' -OutFile $nuevo
  if ((Get-FileHash $nuevo -Algorithm SHA256).Hash -ne $esperado) { throw 'La descarga no es el archivo revisado. No se toco nada.' }

  Copy-Item $dest "$dest.antes-texto-termico" -Force
  Copy-Item $nuevo $dest -Force
  Write-Host 'escpos.js reemplazado (respaldo: escpos.js.antes-texto-termico). Reiniciando el servicio...'
  Restart-Service -Name XaborEdge
  Write-Host "Servicio XaborEdge: $((Get-Service -Name XaborEdge).Status)"

  $js = "const u=require('url');import(u.pathToFileURL(process.argv[1]).href).then(m=>{const b=m.renderComanda({mesa:1,items:[{cantidad:1,producto:'Prueba',persona:{numero:1,nombre:'Ana'}}]});console.log(b.includes(0x14)?'SIGUE EL BYTE 0x14: el arreglo no esta':'OK, imprime: '+b.toString('latin1').match(/ORDEN 1[^\n]*/)[0])})"
  & (Join-Path $base 'node\node.exe') -e $js (Join-Path $dir 'index.js')
}
```

Debe terminar con `Servicio XaborEdge: Running` y
`OK, imprime: ORDEN 1 - ANA`. Esa última línea arma una comanda de prueba con
el Node y los renderers instalados en esa PC, **sin imprimir nada**.

Si se detiene con «no es una versión conocida», el `escpos.js` de esa PC no
viene de este repo tal cual. No se tocó nada y hay que revisarlo antes de
seguir.

### Comprobación en papel (opcional)

En una mesa de prueba, asignar un platillo a «Orden 1» con un nombre y
mandarlo a cocina. Debe salir `ORDEN 1 - NOMBRE` con un guion normal. Al quitar
ese platillo, el papel de CANCELADO trae `Orden 1 - Nombre`.

### Reversa

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $svc = Get-CimInstance Win32_Service -Filter "Name='XaborEdge'"
  if ($svc.PathName -notmatch '^"?([^"]+?\.exe)') { throw "Ruta del servicio no reconocida: $($svc.PathName)" }
  $dest = Join-Path (Split-Path $Matches[1]) 'app\edge\renderers\escpos.js'
  Copy-Item "$dest.antes-texto-termico" $dest -Force
  Restart-Service -Name XaborEdge
  Write-Host "Revertido. Servicio XaborEdge: $((Get-Service -Name XaborEdge).Status)"
}
```

Un Edge que se instale desde cero con el instalador trae el arreglo cuando
`fix/edge-texto-termico` esté en la rama de la que se construye.
