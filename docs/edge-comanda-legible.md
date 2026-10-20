# Comanda de cocina legible

Rama `fix/comanda-cocina-legible`, sobre `fix/edge-texto-termico` (de643d1).
Solo cambia el renderer del Edge (`edge/renderers/`), que corre en la PC de
cada sucursal. **Un despliegue de Railway no cambia el papel.**

## Qué se vio en el papel (20-oct-2026)

En la comanda de Mapolato, con 8 platillos para llevar:

1. «1 CHILAQUILES / SENCILLOS», «1 HUEVOS REVUELTOS / CON JAMÓN» salían en dos
   renglones con medio papel vacío a la derecha.
2. Los modificadores («Salsa: Verde», «Proteína: …») salían en letra normal,
   la mitad de alto que el producto.
3. Se veían grises, opacos, junto al producto en negritas.
4. Los acentos salían cambiados: «Proteφna», «Clßsico», «Chicharr≤n», «JAM╙N».

## Por qué

1. El producto se imprime en doble alto (`GS ! 1`) y el renderer lo envolvía a
   la mitad del ancho (21 columnas en 80 mm), como si cada letra ocupara dos
   columnas. El doble alto solo duplica la altura: caben las 42 columnas.
2. El papel lo pintaba un renderer anterior al 18-sep. Desde 64cd2a3 los
   modificadores ya van en doble alto con viñeta, pero ese renderer nunca se
   instaló en esa PC (el Edge no se actualiza solo).
3. Sin negritas, la térmica traza cada letra con un punto de grueso.
4. La impresora arranca en la tabla de caracteres PC437 (EE. UU.) y el
   renderer manda latin1. Los cuatro acentos de la foto caen exactamente donde
   PC437 pone φ, ß, ≤ y ╙.

## Qué cambia en el papel

- El producto sale en **un renglón** siempre que quepa en el ancho del papel.
  Un nombre más largo se sigue envolviendo, sin pasarse ni perder palabras.
- Los modificadores salen como lista con viñeta (`> Salsa: Verde`), en
  **doble alto y negritas**.
- La nota, como antes desde 64cd2a3: doble alto y negritas.
- Cada papel (comanda, cuenta, cancelación, prueba) elige la tabla **WPC1252**
  (`ESC t 16`) al arrancar, que coincide con latin1: los acentos, la ñ, ¿ y ¡
  salen bien. Una impresora que no conozca esa tabla la ignora y queda como
  hoy.
- La **prueba de impresora** imprime un renglón nuevo:
  `Acentos: áéíóú ÁÉÍÓÚ ñÑ ü ¿? ¡! ·`.

El papel queda **más largo**: cada modificador ocupa el doble de alto (lo
compensa en parte que el producto ya no se parte). Con la comanda de la foto,
medido en renglones de tamaño normal, pasa de 80 a 103: un 30 % más de papel.
Si resulta demasiado, la salida intermedia es dejar los modificadores en
negritas pero en tamaño normal (un cambio de una línea).

Como incluye `fix/edge-texto-termico`, esta instalación **sustituye** a la de
`docs/edge-texto-termico.md`: no hace falta correr las dos.

## Pruebas

Sin Postgres:

- `node test/fase-comanda-modificadores.mjs`: 22 de 23. Casos nuevos 3b
  (un renglón con los nombres de la foto), 3c (nombre largo en 32, 42 y 48
  columnas) y 3d (modificadores en negritas). El caso 15 ya fallaba antes:
  desde 7fd4883 compara un texto literal de `impresionService.js` que cambió
  de forma.
- `node test/fase-edge-texto-termico.mjs`: 9 de 9. Caso nuevo 9: todo papel
  abre con `ESC @` + `ESC t 16` y los acentos viajan como latin1.
- `fase-print-routing`, `fase-edge-tcp`, `fase-ticket-al-cobrar`,
  `fase-restaurante-precuenta` y `fase-autofactura-qr` pasan completas.

Mordidas:

| Se desactiva | Casos que caen |
|---|---|
| envolver el producto a la mitad del ancho (como antes) | 3b, 3c |
| modificadores sin negritas | 3d |
| `INIT` sin `ESC t 16` | 9 |
| la prueba de impresora sin el renglón de acentos | 9 |

Con el producto envuelto a la mitad, el caso 3b imprime exactamente los cortes
de la foto: `1 CHILAQUILES|SENCILLOS|1 COMBITO DE|CHILAQUILES|1 HUEVOS
REVUELTOS|CON JAMÓN|1 COMBITO DE OMELETTE`.

## Instalar en la PC de cada sucursal

Fuera de la hora pico. Al reiniciarse, el servicio espera a que termine la
impresión en curso, y lo que llegue mientras tanto se queda en la cola local
y sale al arrancar.

Se reemplazan los cuatro archivos de `app\edge\renderers\`. El resto del Edge
no se toca: todas sus versiones llaman al renderer igual
(`renderizar(documento, payload, { ancho })`) y piden los mismos cuatro
documentos.

Abrir **PowerShell como administrador** y pegar el bloque completo. Va entre
`& { ... }` para que se ejecute como una sola orden y se detenga antes de
tocar algo si una comprobación falla.

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $commit = '5eac8c32f2db2482561f2cb7991cd6ef4841b706'
  $nuevos = [ordered]@{
    'index.js'         = 'CED8365FA68BA87FDBECF2020A14D3708D7288A399657B3097C04A4AD1D519D8'
    'escpos.js'        = '1159B99E760D29D91C89723C2A7AA43E01951DA4D1983AAD6456BA15C8C10FD2'
    'modificadores.js' = '26230633419383C125C427FB91971E5FAC36154FB1407840BE13541BCCB1C0CC'
    'personas.js'      = '67C80116366A31AD608EB0DF369B60CAE2CCFF91B13ACCE40C60B1E2F0064475'
  }
  $indexConocidos = @{
    'FBF67109FFD5318AE801D62C2F5D83CFDA6C82C344792FF196010604AB29D093' = '7fd4883 (6-oct)'
    'F2BC93AA6EDDEAA5F0A8A6593CDC992371BC19680D179F0DD6086F8AB39506FB' = '7fd4883 (6-oct, CRLF)'
    '30B1020FB02FE8DC83874D8F71583541ECBAAAA0FE02864D5F4780E79A65A49B' = 'db10e61 (24-sep)'
    'B49D8C07B1BA2E2F0C0DB12222CA66749C4B7B040CC8EB9AF112FE2AFC66D806' = 'db10e61 (24-sep, CRLF)'
    'B0CF065A2B79CD95FAC8E3F3EC068C966944D848480013A6F01BE6FE943EAF7E' = '64cd2a3 (18-sep)'
    'AE1174A475320C1E346E717F414925F3F2AA3F028F155194845A90445DCACCEE' = '64cd2a3 (18-sep, CRLF)'
    '8A8C03018FB6A8BCED89ABBA7EFC3FF92EC8212923C529D2E246D792CF7A74F7' = '294ad63 (18-sep)'
    'E0A31A890F456B8D38258AE9CF85DFDCAD832632E1310AA73C54700173B055C7' = '294ad63 (18-sep, CRLF)'
    'DF241E244944AFD2A9CAC991C474A15EF9DF67696B983B9589A1EF107F51C0C7' = '508c1ca (18-sep)'
    '3E4BFE102A32894C643547B68B054934476F91435916EAAE7B8FD60DAC2FE2B8' = '508c1ca (18-sep, CRLF)'
    'BF62DA60FB5C5AE9ED932D7BCFC395A823DD3C1900A244FC6E78815F89A9066E' = '0bfa7e5 (31-ago)'
    '10516553BC4E7F220CDF95190BDD2CDE6C7084F7448BE7F80884CCE1F66CE2DA' = '0bfa7e5 (31-ago, CRLF)'
    '92DD5895E6A320DC896381FFA3124F57F48164A28FB95BCB0CFAAE8F6677A7D1' = '6b4960a (9-ago)'
    '9FFAA5B9A95F2C534A3EE2ABE6A9D0C9C699CD0715B7D88CA0FA125660F4CEC0' = '6b4960a (9-ago, CRLF)'
  }
  $escposConocidos = @{
    '4895A88C70CA2187F21E04DEED532205ECC87E8F569D58BB041207FA01A7863B' = 'de643d1 (15-oct, texto termico)'
    '2D0D0C250ACF233BBF24375BFEF9DE766D7D3F0C983230DE6C2795C77F942161' = 'de643d1 (15-oct, texto termico, CRLF)'
    '3FDE90AA37418FDE4DD2CA9C80623A76E804B5CFB30D6349F284ECA36EB0C79B' = 'db10e61 (24-sep)'
    '95D7714B02E5D3372000B4806AEBC22D0C00D7E1226A40513AA57C403EEEEC0E' = 'db10e61 (24-sep, CRLF)'
    'C72A2A6AF83291F95570408F6B639E45F9869327463058BA0C75C52DE5121764' = '6b4960a (9-ago)'
    'E2052ED50D0F3D579AC2919FCAFD651B8980A0439CA15378822E109AFEE05CE7' = '6b4960a (9-ago, CRLF)'
  }

  $svc = Get-CimInstance Win32_Service -Filter "Name='XaborEdge'"
  if (-not $svc) { throw 'Esta PC no tiene el servicio XaborEdge. No se toco nada.' }
  if ($svc.PathName -notmatch '^"?([^"]+?\.exe)') { throw "Ruta del servicio no reconocida: $($svc.PathName)" }
  $base = Split-Path $Matches[1]
  $dir  = Join-Path $base 'app\edge\renderers'
  $hIndex  = (Get-FileHash (Join-Path $dir 'index.js')  -Algorithm SHA256).Hash
  $hEscpos = (Get-FileHash (Join-Path $dir 'escpos.js') -Algorithm SHA256).Hash
  if ($hIndex -eq $nuevos['index.js'] -and $hEscpos -eq $nuevos['escpos.js']) { Write-Host 'Esta PC ya tiene la comanda legible. No se toco nada.'; return }
  if (-not $indexConocidos.ContainsKey($hIndex))   { throw "index.js instalado no es una version conocida ($hIndex). No se toco nada." }
  if (-not $escposConocidos.ContainsKey($hEscpos)) { throw "escpos.js instalado no es una version conocida ($hEscpos). No se toco nada." }
  Write-Host "Instalado hoy: index.js $($indexConocidos[$hIndex]); escpos.js $($escposConocidos[$hEscpos]). Carpeta: $dir"

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $tmp = Join-Path $env:TEMP 'xabor-comanda-legible'
  New-Item -ItemType Directory -Force $tmp | Out-Null
  foreach ($f in $nuevos.Keys) {
    $descarga = Join-Path $tmp $f
    Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/MapolatoPN/xabor-agent/$commit/edge/renderers/$f" -OutFile $descarga
    if ((Get-FileHash $descarga -Algorithm SHA256).Hash -ne $nuevos[$f]) { throw "La descarga de $f no es el archivo revisado. No se toco nada." }
  }

  $respaldo = "$dir.antes-comanda-legible"
  if (-not (Test-Path $respaldo)) { Copy-Item $dir $respaldo -Recurse }
  foreach ($f in $nuevos.Keys) { Copy-Item (Join-Path $tmp $f) (Join-Path $dir $f) -Force }
  Write-Host "Renderer reemplazado (respaldo: $respaldo). Reiniciando el servicio..."
  Restart-Service -Name XaborEdge
  Write-Host "Servicio XaborEdge: $((Get-Service -Name XaborEdge).Status)"

  $js = "const u=require('url');import(u.pathToFileURL(process.argv[1]).href).then(m=>{const b=m.renderComanda({destino:'PRUEBA',items:[{cantidad:1,producto:'Chilaquiles Sencillos',modificadores:['Salsa: Verde']}]});const s=b.toString('latin1');const r=[b[0]===0x1b&&b[1]===0x40&&b[2]===0x1b&&b[3]===0x74&&b[4]===16,s.includes('1 CHILAQUILES SENCILLOS\n'),s.includes('\x1bE\x01\x1d!\x01  > Salsa: Verde\n')];console.log(r.every(Boolean)?'OK: producto en un renglon, modificadores en negritas, tabla WPC1252':'FALTA ALGO: '+JSON.stringify(r))})"
  & (Join-Path $base 'node\node.exe') -e $js (Join-Path $dir 'index.js')
}
```

Debe terminar con `Servicio XaborEdge: Running` y
`OK: producto en un renglon, modificadores en negritas, tabla WPC1252`. Esa
última línea arma una comanda con el Node y los renderers instalados en esa PC,
**sin imprimir nada**.

Si se detiene con «no es una versión conocida», ese archivo no viene de este
repo tal cual (por ejemplo, la versión del cajón de dinero de 094cd43, que
quedó en una rama lateral). No se tocó nada y hay que revisarlo antes de
seguir.

### Comprobación en papel

1. En el panel, en la sección de impresoras, **Imprimir prueba** en la de
   cocina. El último renglón antes del pie debe decir
   `Acentos: áéíóú ÁÉÍÓÚ ñÑ ü ¿? ¡! ·` tal cual. Si alguna letra sale como
   otro símbolo, la impresora no tomó la tabla 16: avisar y se cambia la
   tabla (no hace falta revertir lo demás).
2. La siguiente comanda real: el producto en un renglón y los modificadores
   grandes y negros.

### Reversa

Regresa los archivos que había antes. `modificadores.js` y `personas.js`
pueden quedarse: el renderer anterior no los usa.

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $svc = Get-CimInstance Win32_Service -Filter "Name='XaborEdge'"
  if ($svc.PathName -notmatch '^"?([^"]+?\.exe)') { throw "Ruta del servicio no reconocida: $($svc.PathName)" }
  $dir = Join-Path (Split-Path $Matches[1]) 'app\edge\renderers'
  $respaldo = "$dir.antes-comanda-legible"
  if (-not (Test-Path $respaldo)) { throw "No hay respaldo en $respaldo. No se toco nada." }
  Copy-Item (Join-Path $respaldo '*') $dir -Force
  Restart-Service -Name XaborEdge
  Write-Host "Revertido. Servicio XaborEdge: $((Get-Service -Name XaborEdge).Status)"
}
```
