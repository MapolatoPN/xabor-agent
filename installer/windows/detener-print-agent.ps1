<#
.SYNOPSIS
  Detiene el Xabor Print Agent, verificando que el PID guardado sea
  realmente ese proceso -- nunca mata todos los node.exe del sistema.

.DESCRIPTION
  Lee agente.pid, confirma que ese PID corresponde a un proceso node.exe
  cuya linea de comando incluye print-agent.js, y solo entonces lo detiene.
  Nunca borra logs ni el archivo de deduplicacion.
#>
[CmdletBinding()]
param(
  [string]$RutaInstalacion
)

$ErrorActionPreference = 'Stop'
# Ver comentario equivalente en iniciar-print-agent.ps1: $PSScriptRoot como
# default de parametro no es fiable en todos los contextos de invocacion.
if ([string]::IsNullOrWhiteSpace($RutaInstalacion)) { $RutaInstalacion = $PSScriptRoot }
function Escribir-Paso($m) { Write-Host "[detener-print-agent] $m" -ForegroundColor Cyan }
function Escribir-Error($m) { Write-Host "[detener-print-agent] ERROR: $m" -ForegroundColor Red }
function Escribir-Ok($m) { Write-Host "[detener-print-agent] OK: $m" -ForegroundColor Green }

$rutaPid = Join-Path $RutaInstalacion 'agente.pid'

if (-not (Test-Path $rutaPid)) {
  Escribir-Ok "No hay archivo agente.pid -- el agente no parece estar corriendo (nada que detener)."
  exit 0
}

$pidGuardado = (Get-Content $rutaPid -ErrorAction SilentlyContinue | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($pidGuardado)) {
  Escribir-Ok "agente.pid esta vacio. Se elimina y no se hace nada mas."
  Remove-Item $rutaPid -Force -ErrorAction SilentlyContinue
  exit 0
}

$proceso = Get-CimInstance Win32_Process -Filter "ProcessId=$pidGuardado" -ErrorAction SilentlyContinue
if (-not $proceso) {
  Escribir-Ok "El PID guardado ($pidGuardado) ya no existe. Se limpia agente.pid."
  Remove-Item $rutaPid -Force -ErrorAction SilentlyContinue
  exit 0
}

if ($proceso.Name -ne 'node.exe' -or $proceso.CommandLine -notlike '*print-agent.js*') {
  Escribir-Error "El PID guardado ($pidGuardado) ya no corresponde al Xabor Print Agent (otro proceso reutilizo ese PID). No se detiene nada por seguridad. Se limpia agente.pid."
  Remove-Item $rutaPid -Force -ErrorAction SilentlyContinue
  exit 1
}

Escribir-Paso "Deteniendo proceso PID $pidGuardado..."
Stop-Process -Id $pidGuardado -Force
Remove-Item $rutaPid -Force -ErrorAction SilentlyContinue
Escribir-Ok "Agente detenido. Logs y archivo de deduplicacion se conservan intactos."
