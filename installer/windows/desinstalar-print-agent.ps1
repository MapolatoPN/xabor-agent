<#
.SYNOPSIS
  Desinstala el Xabor Print Agent, preservando por defecto la
  deduplicacion y los logs.

.DESCRIPTION
  Por defecto SOLO elimina el programa (print-agent.js, package.json,
  node_modules, los scripts de operacion) -- nunca borra dedup\ ni logs\
  sin que se pase -EliminarDatos explicitamente. Tampoco elimina las
  variables de entorno ni la tarea programada salvo que se pida
  explicitamente.

.PARAMETER EliminarDatos
  Tambien elimina la carpeta dedup\ y logs\.

.PARAMETER EliminarVariables
  Tambien elimina las variables de entorno XABOR_* (ambito User y Machine).

.PARAMETER EliminarTareaProgramada
  Tambien elimina la tarea programada 'XaborPrintAgent' si existe.

.PARAMETER Forzar
  Detiene el agente automaticamente si esta corriendo, en vez de abortar.
#>
[CmdletBinding()]
param(
  [string]$RutaInstalacion,
  [switch]$EliminarDatos,
  [switch]$EliminarVariables,
  [switch]$EliminarTareaProgramada,
  [switch]$Forzar
)

$ErrorActionPreference = 'Stop'
# Ver comentario equivalente en iniciar-print-agent.ps1: $PSScriptRoot como
# default de parametro no es fiable en todos los contextos de invocacion.
if ([string]::IsNullOrWhiteSpace($RutaInstalacion)) { $RutaInstalacion = $PSScriptRoot }
function Escribir-Paso($m) { Write-Host "[desinstalar-print-agent] $m" -ForegroundColor Cyan }
function Escribir-Error($m) { Write-Host "[desinstalar-print-agent] ERROR: $m" -ForegroundColor Red }
function Escribir-Ok($m) { Write-Host "[desinstalar-print-agent] OK: $m" -ForegroundColor Green }

$rutaPid = Join-Path $RutaInstalacion 'agente.pid'
if (Test-Path $rutaPid) {
  $pidGuardado = Get-Content $rutaPid -ErrorAction SilentlyContinue | Select-Object -First 1
  $proceso = if ($pidGuardado) { Get-CimInstance Win32_Process -Filter "ProcessId=$pidGuardado" -ErrorAction SilentlyContinue } else { $null }
  $corriendo = $proceso -and $proceso.Name -eq 'node.exe' -and $proceso.CommandLine -like '*print-agent.js*'
  if ($corriendo) {
    if (-not $Forzar) {
      Escribir-Error "El agente esta corriendo (PID $pidGuardado). Detenlo primero con detener-print-agent.ps1, o vuelve a ejecutar con -Forzar."
      exit 1
    }
    Escribir-Paso "Deteniendo agente (PID $pidGuardado) por -Forzar..."
    Stop-Process -Id $pidGuardado -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $rutaPid -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Se va a desinstalar el Xabor Print Agent de: $RutaInstalacion" -ForegroundColor Yellow
Write-Host "  - Se eliminaran: print-agent.js, package.json, node_modules, scripts de operacion."
Write-Host "  - dedup\ y logs\: $(if ($EliminarDatos) { 'SE ELIMINARAN (-EliminarDatos)' } else { 'se conservan' })"
Write-Host "  - Variables de entorno XABOR_*: $(if ($EliminarVariables) { 'SE ELIMINARAN (-EliminarVariables)' } else { 'se conservan' })"
Write-Host "  - Tarea programada 'XaborPrintAgent': $(if ($EliminarTareaProgramada) { 'SE ELIMINARA (-EliminarTareaProgramada)' } else { 'se conserva' })"
$confirmacion = Read-Host "Escribe 'desinstalar' para continuar"
if ($confirmacion -ne 'desinstalar') {
  Escribir-Ok "Cancelado por el usuario. No se elimino nada."
  exit 0
}

foreach ($item in @('print-agent.js', 'package.json', 'node_modules', 'iniciar-print-agent.ps1', 'detener-print-agent.ps1', 'verificar-print-agent.ps1')) {
  $ruta = Join-Path $RutaInstalacion $item
  if (Test-Path $ruta) { Remove-Item $ruta -Recurse -Force }
}
Escribir-Ok "Programa eliminado (dedup\ y logs\ preservados salvo -EliminarDatos)"

if ($EliminarDatos) {
  foreach ($carpeta in @('dedup', 'logs')) {
    $ruta = Join-Path $RutaInstalacion $carpeta
    if (Test-Path $ruta) { Remove-Item $ruta -Recurse -Force }
  }
  Escribir-Ok "dedup\ y logs\ eliminados (-EliminarDatos)"
}

if ($EliminarVariables) {
  foreach ($nombre in @('XABOR_WS_URL', 'XABOR_TERMINAL_ID', 'XABOR_TERMINAL_TOKEN', 'XABOR_PRINTER_NAME', 'XABOR_ANCHO_PAPEL', 'XABOR_DEDUP_FILE')) {
    [Environment]::SetEnvironmentVariable($nombre, $null, 'User')
    [Environment]::SetEnvironmentVariable($nombre, $null, 'Machine')
  }
  Escribir-Ok "Variables de entorno XABOR_* eliminadas (User y Machine)"
}

if ($EliminarTareaProgramada) {
  $tarea = Get-ScheduledTask -TaskName 'XaborPrintAgent' -ErrorAction SilentlyContinue
  if ($tarea) {
    Unregister-ScheduledTask -TaskName 'XaborPrintAgent' -Confirm:$false
    Escribir-Ok "Tarea programada 'XaborPrintAgent' eliminada"
  } else {
    Escribir-Ok "No habia tarea programada 'XaborPrintAgent' que eliminar"
  }
}

Write-Host ""
Escribir-Ok "Desinstalacion completa."
