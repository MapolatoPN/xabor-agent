<#
.SYNOPSIS
  Instala el Xabor Print Agent en una carpeta local de Windows.

.DESCRIPTION
  Copia UNICAMENTE lo necesario para correr print-agent.js de forma aislada
  (no copia el repositorio completo): el propio archivo, un package.json
  minimo con "type":"module", y el paquete 'ws' (unica dependencia externa
  real de print-agent.js -- confirmado por auditoria: el resto son modulos
  nativos de Node: crypto, fs, path, url, os, child_process).

  Este script NUNCA:
    - crea una terminal real en la base de datos;
    - se conecta a Railway ni a ninguna base de datos;
    - imprime el token en pantalla ni en ningun archivo del repositorio;
    - activa el Programador de tareas salvo que se pase -CrearInicioAutomatico;
    - toca una impresora fisica (solo lista impresoras instaladas con Get-Printer
      para que el operador elija el nombre exacto).

  Las variables se guardan como variables de entorno de Windows (por
  defecto, a nivel Usuario) -- NO se crea ningun archivo .env con el token.

.PARAMETER RutaInstalacion
  Carpeta destino. Por defecto: C:\Xabor Print Agent

.PARAMETER RutaRepo
  Carpeta del repositorio origen (donde vive print-agent.js). Por defecto
  se calcula relativa a este script (installer\windows\.. -> raiz del repo).
  Permite apuntar a una copia distinta para pruebas.

.PARAMETER Scope
  'User' (por defecto, no requiere privilegios de administrador) o 'Machine'
  (requiere PowerShell elevado; visible para todos los usuarios de la
  maquina).

.PARAMETER WsUrl
  Valor para XABOR_WS_URL. Si se omite, se solicita interactivamente.

.PARAMETER TerminalId
  Valor para XABOR_TERMINAL_ID. Si se omite, se solicita interactivamente.

.PARAMETER TerminalTokenSeguro
  SecureString con el token. Si se omite, se solicita interactivamente sin
  mostrarlo en pantalla (Read-Host -AsSecureString).

.PARAMETER PrinterName
  Valor para XABOR_PRINTER_NAME (nombre EXACTO tal como aparece en
  Get-Printer). Si se omite, se listan las impresoras instaladas y se
  solicita interactivamente. Nunca se asume una impresora por defecto.

.PARAMETER AnchoPapel
  Valor para XABOR_ANCHO_PAPEL. Por defecto 42.

.PARAMETER CrearInicioAutomatico
  Si se pasa, registra una tarea programada para iniciar el agente al
  encender Windows (con 30s de retraso, reinicio si falla, sin permitir
  multiples instancias). Sin esta bandera, el Programador de tareas NUNCA
  se modifica.

.PARAMETER Simular
  Modo de prueba: ejecuta todas las validaciones y muestra qué haría, pero
  no copia archivos, no guarda variables de entorno, no crea la tarea
  programada.

.EXAMPLE
  # Instalación interactiva típica (variables y token se piden en pantalla)
  .\instalar-print-agent.ps1

.EXAMPLE
  # Instalación con inicio automático, apuntando a una carpeta de prueba
  .\instalar-print-agent.ps1 -RutaInstalacion 'C:\Xabor Print Agent (prueba)' -WsUrl 'wss://ejemplo.invalido' -TerminalId '00000000-0000-0000-0000-000000000000' -PrinterName 'Microsoft Print to PDF' -CrearInicioAutomatico
#>
[CmdletBinding()]
param(
  [string]$RutaInstalacion = 'C:\Xabor Print Agent',
  [string]$RutaRepo,
  [ValidateSet('User', 'Machine')]
  [string]$Scope = 'User',
  [string]$WsUrl,
  [string]$TerminalId,
  [securestring]$TerminalTokenSeguro,
  [string]$PrinterName,
  [int]$AnchoPapel = 42,
  [switch]$CrearInicioAutomatico,
  [switch]$Simular
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot como valor por defecto de parametro no se evalua de forma
# fiable en todos los contextos de invocacion de Windows PowerShell 5.1
# (queda vacio durante el binding aunque luego si este poblado en el
# cuerpo del script) -- se resuelve explicitamente aqui, despues del
# param block, en vez de confiar en el default (hallazgo de pruebas).
if ([string]::IsNullOrWhiteSpace($RutaRepo)) {
  $RutaRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$NODE_VERSION_MINIMA = 18

function Escribir-Paso($mensaje) { Write-Host "[instalar-print-agent] $mensaje" -ForegroundColor Cyan }
function Escribir-Error($mensaje) { Write-Host "[instalar-print-agent] ERROR: $mensaje" -ForegroundColor Red }
function Escribir-Ok($mensaje) { Write-Host "[instalar-print-agent] OK: $mensaje" -ForegroundColor Green }

function Abortar($mensaje) {
  Escribir-Error $mensaje
  exit 1
}

# ── 1. Compatibilidad de Windows ──────────────────────────────────────────
Escribir-Paso "Verificando sistema operativo..."
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Abortar "Este instalador es exclusivamente para Windows."
}
Escribir-Ok "Windows detectado ($([System.Environment]::OSVersion.VersionString))"

# ── 2-4. Node.js: version detectada y minima exigida ──────────────────────
Escribir-Paso "Verificando Node.js..."
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Abortar "Node.js no esta instalado o no esta en PATH. Instala Node.js $NODE_VERSION_MINIMA o superior antes de continuar."
}
$nodeVersionRaw = (& node --version).Trim()
Escribir-Ok "Node.js detectado: $nodeVersionRaw"
if ($nodeVersionRaw -notmatch '^v(\d+)\.') {
  Abortar "No se pudo interpretar la version de Node.js ('$nodeVersionRaw')."
}
$nodeVersionMayor = [int]$Matches[1]
if ($nodeVersionMayor -lt $NODE_VERSION_MINIMA) {
  Abortar "Se requiere Node.js $NODE_VERSION_MINIMA o superior (detectado: $nodeVersionRaw)."
}

# ── Ubicar el print-agent.js de origen ────────────────────────────────────
$origenPrintAgent = Join-Path $RutaRepo 'print-agent.js'
$origenWsModule = Join-Path $RutaRepo 'node_modules\ws'
if (-not (Test-Path $origenPrintAgent)) {
  Abortar "No se encontro print-agent.js en '$origenPrintAgent'. Verifica -RutaRepo."
}
if (-not (Test-Path $origenWsModule)) {
  Abortar "No se encontro node_modules\ws en '$origenWsModule'. Verifica -RutaRepo."
}
Escribir-Ok "Origen localizado: $origenPrintAgent"

# ── Impresora: listar y seleccionar (nunca asumir una por defecto) ────────
if (-not $PrinterName) {
  Escribir-Paso "Impresoras instaladas en este equipo:"
  Get-Printer | Select-Object Name | Format-Table -AutoSize | Out-Host
  $PrinterName = Read-Host "Nombre EXACTO de la impresora a usar (copia el valor de la columna Name)"
}
if ([string]::IsNullOrWhiteSpace($PrinterName)) {
  Abortar "No se indico un nombre de impresora. No se puede continuar sin XABOR_PRINTER_NAME."
}
$impresoraEncontrada = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
if (-not $impresoraEncontrada) {
  Abortar "No existe ninguna impresora instalada con el nombre exacto '$PrinterName'. No se instalara el agente."
}
Escribir-Ok "Impresora confirmada: $PrinterName"

# ── Resto de configuracion ────────────────────────────────────────────────
if (-not $WsUrl) { $WsUrl = Read-Host "XABOR_WS_URL (ej. wss://tu-backend.up.railway.app)" }
if ([string]::IsNullOrWhiteSpace($WsUrl)) { Abortar "XABOR_WS_URL es obligatorio." }

if (-not $TerminalId) { $TerminalId = Read-Host "XABOR_TERMINAL_ID (el terminalId mostrado UNA vez por scripts/crear-terminal-impresion.js)" }
if ([string]::IsNullOrWhiteSpace($TerminalId)) { Abortar "XABOR_TERMINAL_ID es obligatorio." }

if (-not $TerminalTokenSeguro) {
  $TerminalTokenSeguro = Read-Host "XABOR_TERMINAL_TOKEN (no se mostrara en pantalla)" -AsSecureString
}
if (-not $TerminalTokenSeguro -or $TerminalTokenSeguro.Length -eq 0) {
  Abortar "XABOR_TERMINAL_TOKEN es obligatorio."
}
# Se descifra SOLO en memoria, el minimo tiempo posible, y nunca se escribe
# a disco ni se muestra -- ver README.md, seccion "Proteccion del token".
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($TerminalTokenSeguro)
try {
  $tokenPlano = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ($Simular) {
  Escribir-Paso "── MODO SIMULACION (-Simular): no se copia nada, no se guardan variables, no se toca el Programador de tareas ──"
  Escribir-Ok "Se instalaria en: $RutaInstalacion"
  Escribir-Ok "Origen: $origenPrintAgent"
  Escribir-Ok "Impresora: $PrinterName"
  Escribir-Ok "XABOR_WS_URL: (definido, no se muestra el valor completo por politica de esta salida)"
  Escribir-Ok "XABOR_TERMINAL_ID: (definido)"
  Escribir-Ok "XABOR_TERMINAL_TOKEN: (definido, NUNCA se muestra)"
  Escribir-Ok "Ambito de variables: $Scope"
  Escribir-Ok "Inicio automatico: $(if ($CrearInicioAutomatico) { 'se registraria' } else { 'NO se registra (falta -CrearInicioAutomatico)' })"
  $tokenPlano = $null
  exit 0
}

# ── 5-9. Crear estructura de carpetas y copiar SOLO lo necesario ──────────
Escribir-Paso "Creando estructura en '$RutaInstalacion'..."
New-Item -ItemType Directory -Force -Path $RutaInstalacion | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $RutaInstalacion 'logs') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $RutaInstalacion 'dedup') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $RutaInstalacion 'node_modules') | Out-Null

Copy-Item -Path $origenPrintAgent -Destination (Join-Path $RutaInstalacion 'print-agent.js') -Force
Copy-Item -Path $origenWsModule -Destination (Join-Path $RutaInstalacion 'node_modules\ws') -Recurse -Force
Escribir-Ok "print-agent.js y node_modules\ws copiados"

# package.json minimo -- imprescindible para que Node trate print-agent.js
# como ESM fuera del repo (que declara "type":"module" en su propio
# package.json; una copia aislada necesita el suyo).
$packageJsonMinimo = @{
  name        = 'xabor-print-agent'
  version     = '1.0.0'
  private     = $true
  type        = 'module'
  description = 'Instalacion aislada de print-agent.js -- no requiere el repositorio completo.'
} | ConvertTo-Json
Set-Content -Path (Join-Path $RutaInstalacion 'package.json') -Value $packageJsonMinimo -Encoding UTF8
Escribir-Ok "package.json minimo creado"

# Copiar los scripts de operacion junto al agente instalado, para que la
# instalacion sea autosuficiente (no dependa del repositorio despues).
foreach ($script in @('iniciar-print-agent.ps1', 'detener-print-agent.ps1', 'verificar-print-agent.ps1', 'desinstalar-print-agent.ps1')) {
  Copy-Item -Path (Join-Path $PSScriptRoot $script) -Destination (Join-Path $RutaInstalacion $script) -Force
}
Escribir-Ok "Scripts de operacion copiados"

$rutaDedupPorDefecto = Join-Path $RutaInstalacion 'dedup\print-agent-jobs.json'

# ── 10-14. Guardar variables de entorno (nunca se muestra el token) ──────
Escribir-Paso "Guardando variables de entorno (ambito: $Scope)..."
[Environment]::SetEnvironmentVariable('XABOR_WS_URL', $WsUrl, $Scope)
[Environment]::SetEnvironmentVariable('XABOR_TERMINAL_ID', $TerminalId, $Scope)
[Environment]::SetEnvironmentVariable('XABOR_TERMINAL_TOKEN', $tokenPlano, $Scope)
[Environment]::SetEnvironmentVariable('XABOR_PRINTER_NAME', $PrinterName, $Scope)
[Environment]::SetEnvironmentVariable('XABOR_ANCHO_PAPEL', [string]$AnchoPapel, $Scope)
[Environment]::SetEnvironmentVariable('XABOR_DEDUP_FILE', $rutaDedupPorDefecto, $Scope)
# Limpieza deliberada de la variable en memoria del proceso instalador
# (best-effort; PowerShell/.NET no garantiza el borrado fisico, pero evita
# que el valor quede accesible por el resto de la sesion de este script).
$tokenPlano = $null
[System.GC]::Collect()

# Verificar que las variables quedaron definidas SIN mostrar sus valores.
$variablesEsperadas = @('XABOR_WS_URL', 'XABOR_TERMINAL_ID', 'XABOR_TERMINAL_TOKEN', 'XABOR_PRINTER_NAME', 'XABOR_ANCHO_PAPEL', 'XABOR_DEDUP_FILE')
$faltantes = @()
foreach ($nombre in $variablesEsperadas) {
  $valor = [Environment]::GetEnvironmentVariable($nombre, $Scope)
  if ([string]::IsNullOrEmpty($valor)) { $faltantes += $nombre }
}
if ($faltantes.Count -gt 0) {
  Abortar "No se pudieron confirmar estas variables tras guardarlas: $($faltantes -join ', ')"
}
Escribir-Ok "Las 6 variables quedaron definidas (valores no mostrados)"

# ── 16. Inicio automatico -- SOLO con -CrearInicioAutomatico ──────────────
if ($CrearInicioAutomatico) {
  Escribir-Paso "Registrando tarea programada 'XaborPrintAgent'..."
  $accion = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RutaInstalacion\iniciar-print-agent.ps1`""
  $disparador = New-ScheduledTaskTrigger -AtStartup
  $disparador.Delay = 'PT30S'
  $configuracion = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'XaborPrintAgent' -Action $accion -Trigger $disparador -Settings $configuracion -Principal $principal -Force | Out-Null
  Escribir-Ok "Tarea programada registrada (inicio al encender, retraso 30s, sin instancias multiples, reintenta hasta 3 veces)"
} else {
  Escribir-Ok "Inicio automatico NO configurado (usa -CrearInicioAutomatico para activarlo)"
}

Write-Host ""
Escribir-Ok "Instalacion completa en '$RutaInstalacion'"
Write-Host "  Para iniciar:    powershell -File `"$RutaInstalacion\iniciar-print-agent.ps1`""
Write-Host "  Para verificar:  powershell -File `"$RutaInstalacion\verificar-print-agent.ps1`""
Write-Host "  Para detener:    powershell -File `"$RutaInstalacion\detener-print-agent.ps1`""
Write-Host ""
Write-Host "IMPORTANTE: si abriste esta sesion de PowerShell antes de instalar, abre una NUEVA ventana antes de ejecutar iniciar-print-agent.ps1 -- las variables de entorno de nivel Usuario/Maquina no se propagan a sesiones ya abiertas." -ForegroundColor Yellow
