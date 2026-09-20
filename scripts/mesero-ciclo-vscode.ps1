param(
  [ValidateRange(1, 8)][int]$MaxRounds = 4,
  [ValidateRange(15, 360)][int]$MaxMinutes = 180
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repo
if ((git branch --show-current).Trim() -ne 'rescue/mesero-tool-agent') {
  throw 'Abre en VS Code la rama rescue/mesero-tool-agent.'
}

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) {
  $claude = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\claude.exe'
}
$codex = (Get-Command codex -ErrorAction SilentlyContinue).Source
if (-not (Test-Path $claude) -or -not $codex) {
  throw 'Falta Claude Code o Codex CLI. Reinicia VS Code.'
}

$runs = Join-Path $repo '.local-agent-runs'
New-Item -ItemType Directory -Path $runs -Force | Out-Null
$lock = Join-Path $runs 'ciclo-activo.lock'
if (Test-Path $lock) {
  $oldPid = [int](Get-Content $lock -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    throw "Ya hay un ciclo activo (proceso $oldPid)."
  }
  Remove-Item -LiteralPath $lock -Force
}
Set-Content -LiteralPath $lock -Value $PID

# El desarrollo usa la sesión Claude Max. La clave de API queda reservada
# para pruebas del modelo explícitas y no pasa a este proceso automatizado.
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
$started = Get-Date
$base = (git rev-parse HEAD).Trim()
$task = 'Corregir los hallazgos del último dictamen: una caída después del COMMIT debe avisar de verdad a una persona y no debe permitir que un ciclo nuevo duplique el pedido. Fortalecer la prueba fase-agente-confirmacion-perdida y verificarla; después avanzar al siguiente bloqueo local seguro.'
$previousReview = ''
$priorFile = Get-ChildItem $runs -Filter '*-codex.txt' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($priorFile) { $previousReview = Get-Content -LiteralPath $priorFile.FullName -Raw -Encoding UTF8 }

try {
  for ($round = 1; $round -le $MaxRounds; $round++) {
    if (((Get-Date) - $started).TotalMinutes -ge $MaxMinutes) {
      Write-Host "Límite de $MaxMinutes minutos alcanzado. Revisa lo avanzado." -ForegroundColor Yellow
      break
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $prefix = Join-Path $runs "$stamp-ronda$round"
    $buildLog = "$prefix-claude.jsonl"
    $testLog = "$prefix-pruebas.txt"
    $reviewFile = "$prefix-revision.json"
    Write-Host "`n=== Ronda $round de $MaxRounds ===" -ForegroundColor Cyan

    $buildPrompt = @"
Trabaja en Xabor, rama rescue/mesero-tool-agent. Lee CLAUDE.md y docs/mesero-rescue-status.md.
Objetivo de esta ronda: $task
Revisión previa: $previousReview
Limita los cambios a este objetivo y conserva todas las garantías actuales.
No uses credenciales de producción ni modifiques producción. No despliegues,
no actives flags, no hagas merge, commit ni push. No debilites pruebas.
Deja los cambios visibles en Source Control de VS Code. Resume lo logrado.
"@
    & $claude -p $buildPrompt --permission-mode acceptEdits --output-format stream-json |
      ForEach-Object {
        Add-Content -LiteralPath $buildLog -Value $_ -Encoding UTF8
        try {
          $event = $_ | ConvertFrom-Json
          if ($event.type -eq 'assistant') {
            foreach ($block in @($event.message.content)) {
              if ($block.type -eq 'tool_use') { Write-Host "Claude: $($block.name)" }
            }
          }
          if ($event.type -eq 'result') { Write-Host 'Claude terminó esta ronda.' }
        } catch {}
      }
    if ($LASTEXITCODE -ne 0) { throw "Claude Code falló en la ronda $round. Revisa $buildLog" }

    $tests = @('test/fase-agente-tools.mjs', 'test/fase-agente-canario.mjs',
      'test/replay-mesero.mjs', 'test/fase-agente-estado.mjs',
      'test/fase-agente-emision.mjs', 'test/fase-agente-ciclos.mjs',
      'test/fase-agente-confirmacion-perdida.mjs')
    $failed = @()
    foreach ($test in $tests) {
      "== $test ==" | Tee-Object -FilePath $testLog -Append
      node $test | Tee-Object -FilePath $testLog -Append
      if ($LASTEXITCODE -ne 0) { $failed += $test }
    }
    '== mesero:eval (guion) ==' | Tee-Object -FilePath $testLog -Append
    npm.cmd run mesero:eval | Tee-Object -FilePath $testLog -Append
    if ($LASTEXITCODE -ne 0) { $failed += 'mesero:eval' }

    $reviewPrompt = @"
Audita de forma independiente la rama de rescate del Mesero de Xabor.
Compara los cambios desde $base y lee docs/mesero-rescue-status.md.
Pruebas fallidas en esta ronda: $($failed -join ', '). Registro: $testLog.
Busca duplicación de pedidos, fallas tras COMMIT, cruces multiempresa,
integración real al panel/impresión y regresiones. No modifiques archivos.
Marca ready_for_activation=true SOLO si hay evidencia concreta de las puertas
de seguridad, prueba con modelo real y ruta operativa completa. Esto no da
permiso para activar WhatsApp: la activación siempre es manual.
Si queda trabajo local seguro, escribe una sola next_safe_task específica.
Si falta acceso externo, fixture aislado o una decisión humana, marca
needs_external_action=true y explica el bloqueo. No inventes evidencia.
"@
    Write-Host 'Codex revisa en solo lectura.' -ForegroundColor Cyan
    & $codex exec --sandbox read-only --ephemeral `
      --output-schema (Join-Path $PSScriptRoot 'mesero-revision.schema.json') `
      -o $reviewFile $reviewPrompt
    if ($LASTEXITCODE -ne 0) { throw "Codex falló en la ronda $round." }
    $review = Get-Content -LiteralPath $reviewFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $previousReview = $review | ConvertTo-Json -Depth 5 -Compress
    Write-Host "Revisión: $($review.summary)" -ForegroundColor Cyan
    foreach ($blocker in @($review.blockers)) { Write-Host "Pendiente: $blocker" -ForegroundColor Yellow }

    if ($review.ready_for_activation -and $failed.Count -eq 0) {
      Write-Host 'Código listo para revisión de activación. No se activó WhatsApp.' -ForegroundColor Green
      break
    }
    if ($review.needs_external_action -or [string]::IsNullOrWhiteSpace($review.next_safe_task)) {
      Write-Host 'El ciclo se detuvo porque necesita datos, entorno o decisión externa.' -ForegroundColor Yellow
      break
    }
    $task = $review.next_safe_task
  }
  Write-Host "Revisa los informes en $runs y los cambios en Source Control." -ForegroundColor Cyan
  git status --short
} finally {
  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
}
