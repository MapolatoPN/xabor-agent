<#
.SYNOPSIS
  Inicia el Xabor Print Agent instalado, sin permitir una segunda instancia.

.DESCRIPTION
  - Valida que las 4 variables obligatorias existan (nunca muestra el token).
  - Verifica que la carpeta de XABOR_DEDUP_FILE sea escribible.
  - Verifica que la impresora configurada exista en Windows.
  - Verifica que no haya ya una instancia corriendo (archivo agente.pid).
  - Rota el log si supera 5 MB (conserva hasta 5 archivos).
  - Inicia node print-agent.js con stdout/stderr redirigidos a logs\.
  - Guarda el PID real de node.exe (no el de ningun proceso intermedio).

.PARAMETER RutaInstalacion
  Carpeta de instalacion. Por defecto: la carpeta donde vive este script
  (asume que se ejecuta ya copiado dentro de la instalacion).
#>
[CmdletBinding()]
param(
  [string]$RutaInstalacion
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot como valor por defecto de parametro no se evalua de forma
# fiable en todos los contextos de invocacion de Windows PowerShell 5.1
# (queda vacio durante el binding aunque luego si este poblado en el
# cuerpo del script) -- se resuelve explicitamente aqui, despues del
# param block, en vez de confiar en el default.
if ([string]::IsNullOrWhiteSpace($RutaInstalacion)) { $RutaInstalacion = $PSScriptRoot }
$TAMANO_MAXIMO_LOG_BYTES = 5MB
$MAX_LOGS_ROTADOS = 5

function Escribir-Paso($m) { Write-Host "[iniciar-print-agent] $m" -ForegroundColor Cyan }
function Escribir-Error($m) { Write-Host "[iniciar-print-agent] ERROR: $m" -ForegroundColor Red }
function Escribir-Ok($m) { Write-Host "[iniciar-print-agent] OK: $m" -ForegroundColor Green }
function Abortar($m) { Escribir-Error $m; exit 1 }

$rutaPrintAgent = Join-Path $RutaInstalacion 'print-agent.js'
$rutaLogsDir = Join-Path $RutaInstalacion 'logs'
$rutaPid = Join-Path $RutaInstalacion 'agente.pid'
$rutaEstado = Join-Path $RutaInstalacion 'estado.json'
$logOut = Join-Path $rutaLogsDir 'print-agent.log'
$logErr = Join-Path $rutaLogsDir 'print-agent-error.log'

if (-not (Test-Path $rutaPrintAgent)) {
  Abortar "No se encontro print-agent.js en '$RutaInstalacion'. ¿Esta correctamente instalado?"
}

# ── Variables obligatorias -- nunca se muestra ningun valor ───────────────
# Se leen explicitamente de User/Machine (nunca solo 'Process') y se
# guardan en memoria para pasarlas EXPLICITAMENTE al proceso hijo mas
# abajo -- no basta con dejar que el hijo "herede" el entorno de esta
# sesion: si esta sesion de PowerShell ya estaba abierta antes de que se
# guardaran/actualizaran las variables (instalacion o cambio reciente),
# heredar el entorno de la sesion actual propagaria valores desactualizados
# o ausentes al proceso node.exe, aunque esta validacion (que si relee
# directo del registro) haya pasado correctamente.
function Resolver-Var($nombre) {
  $v = [Environment]::GetEnvironmentVariable($nombre, 'User')
  if ([string]::IsNullOrEmpty($v)) { $v = [Environment]::GetEnvironmentVariable($nombre, 'Machine') }
  return $v
}

Escribir-Paso "Validando variables de entorno..."
$obligatorias = @('XABOR_WS_URL', 'XABOR_TERMINAL_ID', 'XABOR_TERMINAL_TOKEN', 'XABOR_PRINTER_NAME')
$valoresResueltos = @{}
$faltantes = @()
foreach ($nombre in $obligatorias) {
  $valor = Resolver-Var $nombre
  if ([string]::IsNullOrEmpty($valor)) { $faltantes += $nombre } else { $valoresResueltos[$nombre] = $valor }
}
if ($faltantes.Count -gt 0) {
  Abortar "Faltan variables de entorno obligatorias: $($faltantes -join ', '). No se inicia el agente."
}
Escribir-Ok "Las 4 variables obligatorias estan definidas"

$printerName = $valoresResueltos['XABOR_PRINTER_NAME']
$anchoPapel = Resolver-Var 'XABOR_ANCHO_PAPEL'
$dedupFile = Resolver-Var 'XABOR_DEDUP_FILE'
if ([string]::IsNullOrEmpty($dedupFile)) { $dedupFile = Join-Path $RutaInstalacion 'dedup\print-agent-jobs.json' }

# ── Impresora debe existir en Windows ──────────────────────────────────────
Escribir-Paso "Verificando impresora '$printerName'..."
$impresora = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
if (-not $impresora) {
  Abortar "La impresora configurada ('$printerName') no existe en este equipo. No se inicia el agente."
}
Escribir-Ok "Impresora encontrada"

# ── Carpeta de deduplicacion debe ser escribible ──────────────────────────
$dedupDir = Split-Path -Parent $dedupFile
if (-not (Test-Path $dedupDir)) {
  New-Item -ItemType Directory -Force -Path $dedupDir | Out-Null
}
try {
  $archivoPrueba = Join-Path $dedupDir ".prueba-escritura-$([guid]::NewGuid()).tmp"
  Set-Content -Path $archivoPrueba -Value 'prueba' -ErrorAction Stop
  Remove-Item $archivoPrueba -Force -ErrorAction SilentlyContinue
} catch {
  Abortar "La carpeta de XABOR_DEDUP_FILE ('$dedupDir') no es escribible: $($_.Exception.Message)"
}
Escribir-Ok "Carpeta de deduplicacion escribible"

# ── Evitar una segunda instancia ──────────────────────────────────────────
if (Test-Path $rutaPid) {
  $pidExistente = Get-Content $rutaPid -ErrorAction SilentlyContinue
  if ($pidExistente) {
    $procExistente = Get-CimInstance Win32_Process -Filter "ProcessId=$pidExistente" -ErrorAction SilentlyContinue
    if ($procExistente -and $procExistente.Name -eq 'node.exe' -and $procExistente.CommandLine -like '*print-agent.js*') {
      Abortar "Ya hay una instancia corriendo (PID $pidExistente). Usa detener-print-agent.ps1 primero si quieres reiniciarla."
    }
  }
  Remove-Item $rutaPid -Force -ErrorAction SilentlyContinue
}

# ── Rotacion simple de logs (antes de empezar, no durante la ejecucion) ──
function Rotar-LogSiExcede($ruta) {
  if ((Test-Path $ruta) -and ((Get-Item $ruta).Length -ge $TAMANO_MAXIMO_LOG_BYTES)) {
    for ($i = $MAX_LOGS_ROTADOS - 1; $i -ge 1; $i--) {
      $origen = "$ruta.$i"
      $destino = "$ruta.$($i + 1)"
      if (Test-Path $origen) {
        if ($i -eq ($MAX_LOGS_ROTADOS - 1)) { Remove-Item $destino -Force -ErrorAction SilentlyContinue }
        Move-Item $origen $destino -Force
      }
    }
    Move-Item $ruta "$ruta.1" -Force
  }
}
Rotar-LogSiExcede $logOut
Rotar-LogSiExcede $logErr
New-Item -ItemType Directory -Force -Path $rutaLogsDir | Out-Null

# ── Iniciar node directamente (PID real, no de un proceso intermedio) ────
# Start-Process redirige stdout/stderr a archivo a nivel de sistema
# operativo (el archivo sigue recibiendo datos aunque este script termine
# despues de lanzarlo) -- se prefiere sobre invocar Process.Start()
# manualmente, que requeriria mantener este proceso vivo para relayar los
# streams. Para que el proceso hijo vea las variables XABOR_* recien
# resueltas (y no una version desactualizada heredada de esta sesion, ver
# comentario arriba), se actualiza el entorno de ESTE proceso -- de corta
# vida, solo lanza y termina -- antes de llamar a Start-Process, que hereda
# de aqui.
foreach ($nombre in $obligatorias) { [Environment]::SetEnvironmentVariable($nombre, $valoresResueltos[$nombre], 'Process') }
if ($anchoPapel) { [Environment]::SetEnvironmentVariable('XABOR_ANCHO_PAPEL', $anchoPapel, 'Process') }
[Environment]::SetEnvironmentVariable('XABOR_DEDUP_FILE', $dedupFile, 'Process')

Escribir-Paso "Iniciando print-agent.js..."
$proceso = Start-Process -FilePath 'node' -ArgumentList "`"$rutaPrintAgent`"" `
  -WorkingDirectory $RutaInstalacion `
  -RedirectStandardOutput $logOut `
  -RedirectStandardError $logErr `
  -WindowStyle Hidden -PassThru

Start-Sleep -Milliseconds 500
if ($proceso.HasExited) {
  Abortar "El proceso termino inmediatamente (codigo $($proceso.ExitCode)). Revisa $logErr."
}

Set-Content -Path $rutaPid -Value $proceso.Id -Encoding ASCII
$estado = @{ ultimoInicio = (Get-Date -Format 'o'); pid = $proceso.Id } | ConvertTo-Json
Set-Content -Path $rutaEstado -Value $estado -Encoding UTF8

Escribir-Ok "Agente iniciado. PID: $($proceso.Id)"
Write-Host "  Log:        $logOut"
Write-Host "  Log errores: $logErr"
