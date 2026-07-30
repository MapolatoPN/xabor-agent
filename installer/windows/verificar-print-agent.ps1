<#
.SYNOPSIS
  Muestra el estado del Xabor Print Agent sin revelar secretos.

.DESCRIPTION
  Nunca muestra: el token, payloads, telefonos, clientes ni pedidos. El
  terminalId se muestra parcialmente enmascarado (primeros/ultimos 4
  caracteres) por ser un identificador semi-sensible.
#>
[CmdletBinding()]
param(
  [string]$RutaInstalacion,
  [int]$LineasLog = 15
)

# Ver comentario equivalente en iniciar-print-agent.ps1: $PSScriptRoot como
# default de parametro no es fiable en todos los contextos de invocacion.
if ([string]::IsNullOrWhiteSpace($RutaInstalacion)) { $RutaInstalacion = $PSScriptRoot }

function Titulo($m) { Write-Host "`n== $m ==" -ForegroundColor Cyan }
function Enmascarar($valor) {
  if (-not $valor -or $valor.Length -le 8) { return '****' }
  return "$($valor.Substring(0,4))…$($valor.Substring($valor.Length-4,4))"
}
# Filtro defensivo adicional: aunque print-agent.js nunca loguea el token,
# esta funcion redacta cualquier linea que contenga la palabra 'token'
# seguida de un valor, como segunda capa de seguridad antes de mostrar el
# log en pantalla.
function Redactar-LineaSegura($linea) {
  if ($linea -match '(?i)token\s*[:=]\s*\S+') {
    return ($linea -replace '(?i)(token\s*[:=]\s*)\S+', '$1[REDACTADO]')
  }
  return $linea
}

Titulo "Instalacion"
$rutaPrintAgent = Join-Path $RutaInstalacion 'print-agent.js'
$instalado = Test-Path $rutaPrintAgent
Write-Host "Instalado: $(if ($instalado) { 'si' } else { 'no' }) ($RutaInstalacion)"
if (-not $instalado) { exit 0 }

Titulo "Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  Write-Host "Node detectado: $((& node --version).Trim())"
} else {
  Write-Host "Node detectado: NO"
}

Titulo "Variables de entorno"
$obligatorias = @('XABOR_WS_URL', 'XABOR_TERMINAL_ID', 'XABOR_TERMINAL_TOKEN', 'XABOR_PRINTER_NAME')
function ObtenerVar($nombre) {
  $v = [Environment]::GetEnvironmentVariable($nombre, 'User')
  if ([string]::IsNullOrEmpty($v)) { $v = [Environment]::GetEnvironmentVariable($nombre, 'Machine') }
  return $v
}
$todasPresentes = $true
foreach ($nombre in $obligatorias) {
  $v = ObtenerVar $nombre
  $presente = -not [string]::IsNullOrEmpty($v)
  if (-not $presente) { $todasPresentes = $false }
  if ($nombre -eq 'XABOR_TERMINAL_TOKEN') {
    Write-Host "  XABOR_TERMINAL_TOKEN presente: $(if ($presente) { 'si' } else { 'no' }) (nunca se muestra el valor)"
  } elseif ($nombre -eq 'XABOR_TERMINAL_ID') {
    Write-Host "  XABOR_TERMINAL_ID presente: $(if ($presente) { 'si' } else { 'no' }) $(if ($presente) { "(enmascarado: $(Enmascarar $v))" })"
  } else {
    Write-Host "  $nombre presente: $(if ($presente) { 'si' } else { 'no' })"
  }
}
Write-Host "Variables requeridas presentes (todas): $(if ($todasPresentes) { 'si' } else { 'no' })"

Titulo "Impresora"
$printerName = ObtenerVar 'XABOR_PRINTER_NAME'
if ($printerName) {
  $impresora = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
  Write-Host "Impresora configurada encontrada en Windows: $(if ($impresora) { 'si' } else { 'no' })"
} else {
  Write-Host "Impresora configurada encontrada en Windows: no (variable no definida)"
}

Titulo "Proceso"
$rutaPid = Join-Path $RutaInstalacion 'agente.pid'
$activo = $false
$pidMostrado = '(ninguno)'
if (Test-Path $rutaPid) {
  $pidGuardado = Get-Content $rutaPid -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidGuardado) {
    $proceso = Get-CimInstance Win32_Process -Filter "ProcessId=$pidGuardado" -ErrorAction SilentlyContinue
    if ($proceso -and $proceso.Name -eq 'node.exe' -and $proceso.CommandLine -like '*print-agent.js*') {
      $activo = $true
      $pidMostrado = $pidGuardado
    }
  }
}
Write-Host "Proceso activo: $(if ($activo) { 'si' } else { 'no' })"
Write-Host "PID: $pidMostrado"

Titulo "Ultimo inicio"
$rutaEstado = Join-Path $RutaInstalacion 'estado.json'
if (Test-Path $rutaEstado) {
  try {
    $estado = Get-Content $rutaEstado -Raw | ConvertFrom-Json
    Write-Host "Ultimo inicio: $($estado.ultimoInicio)"
  } catch {
    Write-Host "Ultimo inicio: (estado.json ilegible)"
  }
} else {
  Write-Host "Ultimo inicio: (sin registro)"
}

Titulo "Deduplicacion"
$dedupFile = ObtenerVar 'XABOR_DEDUP_FILE'
if (-not $dedupFile) { $dedupFile = Join-Path $RutaInstalacion 'dedup\print-agent-jobs.json' }
$dedupAccesible = $false
if (Test-Path $dedupFile) {
  try { Get-Content $dedupFile -Raw -ErrorAction Stop | Out-Null; $dedupAccesible = $true } catch {}
}
Write-Host "Archivo de deduplicacion accesible: $(if ($dedupAccesible) { 'si' } else { 'no' }) ($dedupFile)"

Titulo "Log (ultimas $LineasLog lineas seguras)"
$logOut = Join-Path $RutaInstalacion 'logs\print-agent.log'
$conexionWs = $false
$autenticacionOk = $false
if (Test-Path $logOut) {
  $lineas = Get-Content $logOut -Tail 500 -ErrorAction SilentlyContinue
  if ($lineas) {
    $conexionWs = ($lineas | Select-String -Pattern '\[WS\] Conectando' -Quiet)
    $autenticacionOk = ($lineas | Select-String -Pattern 'Terminal autenticada' -Quiet)
    $lineas | Select-Object -Last $LineasLog | ForEach-Object { Write-Host "  $(Redactar-LineaSegura $_)" }
  }
} else {
  Write-Host "  (sin archivo de log todavia)"
}

Titulo "Resumen de conexion (segun logs)"
Write-Host "Conexion WebSocket intentada: $(if ($conexionWs) { 'si' } else { 'no/desconocido' })"
Write-Host "Autenticacion exitosa: $(if ($autenticacionOk) { 'si' } else { 'no/desconocido' })"
