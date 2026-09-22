<#
  mesero-duo-local.ps1 — arnes local Claude (construye) + Codex (revisa, solo lectura)

  Historial: este script empezo con la rama del canario del Mesero
  (rescue/mesero-tool-agent) escrita a fuego. Eso hizo que una tarea que en
  realidad pertenecia a otra rama terminara construida dentro del canario,
  porque el script no tenia forma de apuntar a otro lado.

  Ahora es generico y parametrizable:
    - El worktree, la rama esperada y el objetivo son parametros EXPLICITOS
      y obligatorios de hecho: sin alguno de los tres, el script aborta con
      throw antes de tocar nada, sin lanzar Claude ni Codex. Ya no existe
      ningun camino que derive el worktree en silencio de donde vive este
      script -- ese camino era exactamente la causa del bug original, y se
      elimino por completo (no queda modo de compatibilidad implicito).
    - No hay ninguna rama ni ruta de proyecto especifica escrita en este
      archivo. Antes de tocar nada, se verifica que el worktree pedido
      exista, sea un repo Git valido, este EXACTAMENTE en la rama esperada,
      y no tenga cambios pendientes. Si algo de eso falla, aborta antes de
      lanzar Claude o Codex.
    - Las pruebas ya no estan hardcodeadas al Mesero: -TestFiles es
      opcional. Si se dan archivos, se corren. Si no, el arnes NO inventa
      ninguna suite — le toca a Claude correr lo pertinente como parte de
      su propio trabajo, y asi se lo dice el prompt.
    - CLAUDE.md se sigue leyendo si existe en el worktree objetivo.
      docs/mesero-rescue-status.md ya NO es parte del flujo generico: era
      especifico del rescate del Mesero y no tiene sentido para otro
      proyecto o worktree.
    - Codex recibe, ademas del diff contra el commit base, el status corto
      y la lista de archivos SIN RASTREAR despues de que Claude termino,
      pegados literalmente en su prompt. Un archivo nuevo que Claude creo
      y nunca metio al indice de Git no aparece en "git diff" -- por eso no
      basta con el diff solo, y se le pide a Codex que revise cada archivo
      sin rastrear como si fuera parte del cambio, porque lo es.

  Reglas que se mantienen igual que siempre:
    - Claude construye (con permiso de editar). Codex revisa en
      --sandbox read-only, nunca modifica nada. El arnes tampoco hace
      git add ni toca el staging en ningun momento.
    - Nunca commit, nunca push, nunca merge, nunca deploy, nunca se toca
      produccion. Los cambios quedan sin commit para revisar a mano.
    - Los logs de la ronda se guardan en .local-agent-runs DENTRO del
      worktree objetivo (no donde vive este script).

  Compatible con Windows PowerShell 5.1 y con PowerShell 7+: sin operador
  ternario, sin ??, sin && / || de shell, todo con if/else e
  if ($LASTEXITCODE -ne 0).
#>
param(
  # Carpeta del worktree donde Claude y Codex van a trabajar de verdad.
  # OBLIGATORIO en la practica: sin valor por defecto y sin derivarlo de
  # donde vive este script. Antes, si faltaba, el script asumia en silencio
  # "el repo de PSScriptRoot" -- y ese fue exactamente el mecanismo que hizo
  # que una tarea ajena terminara construida sobre la rama del canario, solo
  # porque el script vivia ahi. Ya no existe ese camino: sin -Worktree, el
  # script aborta antes de tocar nada.
  [string]$Worktree = '',

  # Rama que ese worktree DEBE tener activa. Tampoco tiene valor por
  # defecto: el bug original era justo una rama fija aqui adentro.
  [string]$ExpectedBranch = '',

  # Que se le pide a Claude. Tampoco tiene un valor por defecto especifico
  # de ningun proyecto.
  [string]$Task = '',

  # Rutas de prueba (relativas al worktree) a correr DESPUES de Claude.
  # Si se omite, el arnes no corre nada por su cuenta — se lo deja a Claude.
  [string[]]$TestFiles = @(),

  # Corre solo las validaciones (worktree, rama, arbol limpio) y termina.
  # No toca disco, no invoca Claude ni Codex. Sirve para demostrar que el
  # candado funciona sin gastar una corrida real.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Test-ParametroRequerido {
  param([string]$Valor, [string]$NombreParametro, [string]$Ejemplo)
  if ([string]::IsNullOrWhiteSpace($Valor)) {
    throw "Falta -$NombreParametro. Ejemplo: $Ejemplo"
  }
}

# ── 1. Worktree, ExpectedBranch y Task son obligatorios DE HECHO, sin
# [Parameter(Mandatory=$true)]: ese atributo puede colgarse esperando
# entrada interactiva en PowerShell 5.1 cuando el script corre sin una
# terminal real (por ejemplo, desde una tarea de VS Code sin stdin). Aqui
# se valida y se aborta con throw de inmediato -- nunca se cuelga, y ya
# NO existe ningun valor por defecto ni modo de compatibilidad que derive
# el worktree en silencio. ──
Test-ParametroRequerido -Valor $Worktree -NombreParametro 'Worktree' `
  -Ejemplo "-Worktree 'C:\ruta\al\worktree'"
Test-ParametroRequerido -Valor $ExpectedBranch -NombreParametro 'ExpectedBranch' `
  -Ejemplo "-ExpectedBranch 'feat/mi-rama'"
Test-ParametroRequerido -Valor $Task -NombreParametro 'Task' `
  -Ejemplo "-Task 'Descripcion acotada del cambio'"

# ── 2. Resolve-Path del worktree: tiene que existir, tal cual, antes de nada ──
try {
  $WorktreeResuelto = (Resolve-Path -LiteralPath $Worktree -ErrorAction Stop).Path
} catch {
  throw "El worktree '$Worktree' no existe o no se pudo resolver. $($_.Exception.Message)"
}

# ── 3. Tiene que ser un repo/worktree Git valido — no una carpeta cualquiera ──
$esRepoGit = $null
try {
  $esRepoGit = (git -C $WorktreeResuelto rev-parse --is-inside-work-tree 2>$null)
} catch {
  $esRepoGit = $null
}
if ($LASTEXITCODE -ne 0 -or -not $esRepoGit -or $esRepoGit.Trim() -ne 'true') {
  throw "'$WorktreeResuelto' no es un repositorio o worktree Git valido."
}

# ── 4. La rama activa AHI ADENTRO tiene que coincidir EXACTO con la esperada ──
$RamaActual = (git -C $WorktreeResuelto branch --show-current 2>$null)
if ($null -eq $RamaActual) { $RamaActual = '' }
$RamaActual = $RamaActual.Trim()
$RamaMostrada = $RamaActual
if ([string]::IsNullOrWhiteSpace($RamaMostrada)) { $RamaMostrada = '(HEAD separado / sin rama activa)' }

if ($RamaActual -ne $ExpectedBranch) {
  Write-Host 'ABORTADO: el worktree no esta en la rama esperada.' -ForegroundColor Red
  Write-Host "  Rama esperada  : $ExpectedBranch"
  Write-Host "  Rama encontrada: $RamaMostrada"
  Write-Host "  Ruta           : $WorktreeResuelto"
  throw 'La rama activa no coincide con -ExpectedBranch. Abortado antes de lanzar Claude o Codex.'
}

# ── 5. Arbol de trabajo limpio: sin esto, la ronda se mezcla con otra cosa ──
$Pendientes = git -C $WorktreeResuelto status --porcelain
if ($Pendientes) {
  Write-Host "Hay cambios pendientes en $WorktreeResuelto :" -ForegroundColor Red
  Write-Host $Pendientes
  throw 'Hay cambios pendientes. Revisa o confirma esos cambios antes de iniciar otra ronda.'
}

Write-Host 'Validacion del worktree: OK' -ForegroundColor Green
Write-Host "  Worktree : $WorktreeResuelto"
Write-Host "  Rama     : $RamaActual"
Write-Host "  Arbol    : limpio"

if ($DryRun) {
  Write-Host ''
  Write-Host '-DryRun: validacion completa, no se lanza ningun agente.' -ForegroundColor Cyan
  exit 0
}

# ── A partir de aqui, la ronda es real: Claude y Codex corren FISICAMENTE ──
# sobre $WorktreeResuelto. Ninguna ruta de aqui en adelante depende de
# PSScriptRoot ni de ningun otro repo.
Set-Location $WorktreeResuelto

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) {
  $claude = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\claude.exe'
}
$codex = (Get-Command codex -ErrorAction SilentlyContinue).Source
if (-not (Test-Path $claude) -or -not $codex) {
  throw 'Falta Claude Code o Codex CLI. Reinicia VS Code y vuelve a intentar.'
}

$base = (git -C $WorktreeResuelto rev-parse HEAD).Trim()
$run = Join-Path $WorktreeResuelto '.local-agent-runs'
New-Item -ItemType Directory -Path $run -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$buildLog = Join-Path $run "$stamp-claude.txt"
$reviewLog = Join-Path $run "$stamp-codex.txt"
$testLog = Join-Path $run "$stamp-tests.txt"
$diffLog = Join-Path $run "$stamp-diff.txt"
$statusLog = Join-Path $run "$stamp-status.txt"
$untrackedLog = Join-Path $run "$stamp-untracked.txt"

# La CLI usa la sesion ya iniciada. La clave de API local se reserva para
# corridas explicitas (por ejemplo humo con modelo real) y no se hereda aqui.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

# ── El prompt de Claude: CLAUDE.md si existe en ESTE worktree; nada del
# rescate del Mesero, que era especifico de otro proyecto y otra rama ──
$ClaudeMdPath = Join-Path $WorktreeResuelto 'CLAUDE.md'
$InstruccionClaudeMd = ''
if (Test-Path $ClaudeMdPath) {
  $InstruccionClaudeMd = 'Lee CLAUDE.md en la raiz de este worktree antes de empezar.'
} else {
  $InstruccionClaudeMd = 'Este worktree no tiene CLAUDE.md; procede con el objetivo tal cual se describe abajo.'
}

$InstruccionPruebas = ''
if ($TestFiles -and $TestFiles.Count -gt 0) {
  $InstruccionPruebas = "Al terminar, corre estas pruebas y deja constancia del resultado: $($TestFiles -join ', ')"
} else {
  $InstruccionPruebas = 'No hay una lista de pruebas fija para esta ronda: ejecuta durante tu trabajo las pruebas que sean pertinentes al cambio que hiciste. No asumas ninguna suite predefinida de otro proyecto.'
}

$buildPrompt = @"
Trabaja SOLO dentro de este worktree: $WorktreeResuelto (rama $RamaActual).
$InstruccionClaudeMd
Objetivo acotado: $Task
No despliegues, no actives ningun canario ni sombra, no cambies datos de produccion,
no hagas merge, no hagas push, no hagas commit.
No cambies archivos ajenos al objetivo.
$InstruccionPruebas
Deja los cambios sin commit para que aparezcan en Source Control de VS Code.
Al terminar, resume archivos tocados, pruebas corridas y riesgos pendientes.
"@

Write-Host "Claude Code construye en $WorktreeResuelto" -ForegroundColor Cyan
& $claude -p $buildPrompt --permission-mode acceptEdits | Tee-Object -FilePath $buildLog
if ($LASTEXITCODE -ne 0) { throw "Claude Code termino con error. Revisa $buildLog" }

# ── Pruebas: solo las que se pidieron explicitamente. Nada inventado aqui ──
$testFailed = $false
if ($TestFiles -and $TestFiles.Count -gt 0) {
  foreach ($test in $TestFiles) {
    "== $test ==" | Tee-Object -FilePath $testLog -Append
    node $test | Tee-Object -FilePath $testLog -Append
    if ($LASTEXITCODE -ne 0) { $testFailed = $true }
  }
} else {
  $sinPruebas = 'No se proporcionaron -TestFiles. El arnes no corrio ninguna suite propia; Claude debio ejecutar las pruebas pertinentes como parte de su trabajo (ver el log de Claude arriba).'
  $sinPruebas | Tee-Object -FilePath $testLog -Append
}

$ResumenPruebas = ''
if ($TestFiles -and $TestFiles.Count -gt 0) {
  $ResumenPruebas = "Se corrieron estas pruebas (detalle en $testLog): $($TestFiles -join ', '). Alguna fallo: $testFailed."
} else {
  $ResumenPruebas = "No se proporcionaron -TestFiles para esta ronda. El arnes no ejecuto ninguna suite propia (ver $testLog); revisa en el log de Claude que pruebas corrio por su cuenta."
}

# ── El diff contra el commit base (SOLO archivos que Git ya rastreaba) ──
git -C $WorktreeResuelto diff $base | Out-File -FilePath $diffLog -Encoding utf8

# ── El estado completo, para que Codex no tenga que adivinar que cambio.
# "git diff" nunca muestra un archivo que Claude creo y no metio al indice
# -- por eso se capturan TAMBIEN el status corto y la lista de archivos sin
# rastrear, y las dos salidas se pegan LITERALMENTE en el prompt de Codex,
# no solo como referencia a un archivo de log. El arnes no hace git add en
# ningun momento: esto es lectura pura. ──
$EstadoCorto = (git -C $WorktreeResuelto status --short | Out-String).TrimEnd()
$EstadoCorto | Out-File -FilePath $statusLog -Encoding utf8

$ArchivosSinRastrear = (git -C $WorktreeResuelto ls-files --others --exclude-standard | Out-String).TrimEnd()
$ArchivosSinRastrear | Out-File -FilePath $untrackedLog -Encoding utf8

$EstadoCortoMostrado = $EstadoCorto
if ([string]::IsNullOrWhiteSpace($EstadoCortoMostrado)) {
  $EstadoCortoMostrado = '(sin cambios: el arbol quedo igual que el commit base)'
}
$ArchivosSinRastrearMostrados = $ArchivosSinRastrear
if ([string]::IsNullOrWhiteSpace($ArchivosSinRastrearMostrados)) {
  $ArchivosSinRastrearMostrados = '(ninguno)'
}

$reviewPrompt = @"
Revisa como auditor independiente el trabajo de Claude Code en el worktree $WorktreeResuelto (rama $RamaActual).
Objetivo que se le dio a Claude: $Task
Commit base, tomado de este worktree ANTES de que Claude empezara: $base
Diff completo despues de Claude (solo archivos que Git ya rastreaba), guardado en: $diffLog

git status --short despues de Claude:
$EstadoCortoMostrado

git ls-files --others --exclude-standard (archivos NUEVOS, sin rastrear):
$ArchivosSinRastrearMostrados

$ResumenPruebas
No modifiques ningun archivo. No hagas git add. No cambies el staging de ninguna forma.
Revisa:
- el diff contra el commit base ($base)
- TODOS los archivos modificados que aparecen en el status de arriba
- CADA archivo sin rastrear de la lista de arriba, individualmente -- un archivo sin
  rastrear es parte del cambio de esta ronda AUNQUE NO aparezca en "git diff $base",
  porque ese diff nunca muestra archivos que Git no rastreaba antes de esta ronda
- cruces multiempresa: cualquier dato o consulta que pueda mezclar un negocio con otro
- regresiones sobre codigo que ya existia y funcionaba
- cualquier archivo creado o modificado que caiga FUERA del objetivo declarado arriba,
  este rastreado o no
Devuelve hallazgos concretos con archivo y linea; si no hay hallazgos, dilo explicitamente.
"@

Write-Host 'Codex revisa en modo de solo lectura' -ForegroundColor Cyan
& $codex exec --sandbox read-only --ephemeral -o $reviewLog $reviewPrompt
if ($LASTEXITCODE -ne 0) { throw "Codex termino con error. Revisa $reviewLog" }

Write-Host "Ronda terminada. Revision: $reviewLog" -ForegroundColor Green
git -C $WorktreeResuelto status --short
