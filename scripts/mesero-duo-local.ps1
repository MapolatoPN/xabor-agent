param(
  [string]$Task = 'Agregar una prueba aislada del caso en que registrarPedido confirma en Postgres pero se pierde la respuesta antes de guardar el estado. Verificar que el siguiente turno no cree otro pedido. No tocar producción.'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repo

if ((git branch --show-current).Trim() -ne 'rescue/mesero-tool-agent') {
  throw 'Abre la rama rescue/mesero-tool-agent antes de iniciar los agentes.'
}
if (git status --porcelain) {
  throw 'Hay cambios pendientes. Revisa o confirma esos cambios antes de iniciar otra ronda.'
}

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) {
  $claude = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\claude.exe'
}
$codex = (Get-Command codex -ErrorAction SilentlyContinue).Source
if (-not (Test-Path $claude) -or -not $codex) {
  throw 'Falta Claude Code o Codex CLI. Reinicia VS Code y vuelve a intentar.'
}

$base = (git rev-parse HEAD).Trim()
$run = Join-Path $repo '.local-agent-runs'
New-Item -ItemType Directory -Path $run -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$buildLog = Join-Path $run "$stamp-claude.txt"
$reviewLog = Join-Path $run "$stamp-codex.txt"
$testLog = Join-Path $run "$stamp-tests.txt"

# La CLI usa la sesión Claude Max ya iniciada. La clave de API local se reserva
# para el humo explícito y no se hereda en esta ronda de desarrollo.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

$buildPrompt = @"
Trabaja solo en esta rama y carpeta de Xabor. Lee CLAUDE.md y docs/mesero-rescue-status.md.
Objetivo acotado: $Task
No despliegues, no actives canario ni sombra, no cambies datos de producción, no hagas merge, no hagas push.
No cambies archivos ajenos al objetivo. Ejecuta las pruebas seguras que correspondan.
Deja los cambios sin commit para que aparezcan en Source Control de VS Code.
Al terminar, resume archivos, pruebas y riesgos pendientes.
"@

Write-Host "Claude Code construye en $repo" -ForegroundColor Cyan
& $claude -p $buildPrompt --permission-mode acceptEdits | Tee-Object -FilePath $buildLog
if ($LASTEXITCODE -ne 0) { throw "Claude Code terminó con error. Revisa $buildLog" }

$tests = @('test/fase-agente-tools.mjs', 'test/fase-agente-canario.mjs',
  'test/replay-mesero.mjs', 'test/fase-agente-estado.mjs',
  'test/fase-agente-emision.mjs', 'test/fase-agente-ciclos.mjs')
$testFailed = $false
foreach ($test in $tests) {
  "== $test ==" | Tee-Object -FilePath $testLog -Append
  node $test | Tee-Object -FilePath $testLog -Append
  if ($LASTEXITCODE -ne 0) { $testFailed = $true }
}

$reviewPrompt = @"
Revisa como auditor independiente el trabajo de Claude Code en este repositorio.
Base previa: $base. Lee el diff actual y los archivos relevantes.
Busca errores funcionales, duplicación de pedidos, cruces entre negocios,
riesgos de despliegue y pruebas insuficientes. No modifiques archivos.
Las pruebas seguras fallaron: $testFailed. Consulta $testLog si hace falta.
Devuelve hallazgos concretos con archivo y línea; si no hay hallazgos, dilo.
"@

Write-Host 'Codex revisa en modo de solo lectura' -ForegroundColor Cyan
& $codex exec --sandbox read-only --ephemeral -o $reviewLog $reviewPrompt
if ($LASTEXITCODE -ne 0) { throw "Codex terminó con error. Revisa $reviewLog" }

Write-Host "Ronda terminada. Revisión: $reviewLog" -ForegroundColor Green
git status --short
