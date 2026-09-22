param(
  [string]$Service = 'xabor-agent',
  [string]$Message = ''
)

$ErrorActionPreference = 'Stop'

# Railway CLI sigue el directorio Git común cuando se ejecuta dentro de un
# worktree. Eso puede subir el checkout principal en vez del commit que se está
# revisando. Este script crea un archivo del HEAD exacto, verifica su contenido
# y usa --path-as-root para que la raíz subida sea inequívoca.
$commit = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or !$commit) { throw 'No se pudo resolver HEAD.' }

$sucio = git status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'No se pudo comprobar el estado de Git.' }
if ($sucio) { throw 'El despliegue exige un commit limpio. Guarda los cambios antes de continuar.' }

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stage = [IO.Path]::Combine($tempRoot, "xabor-deploy-$($commit.Substring(0, 12))-$PID")
$zip = "$stage.zip"

try {
  if (Test-Path -LiteralPath $stage) { throw "El staging ya existe: $stage" }
  if (Test-Path -LiteralPath $zip) { throw "El archivo temporal ya existe: $zip" }

  git archive --format=zip --output=$zip $commit
  if ($LASTEXITCODE -ne 0) { throw 'git archive no pudo empaquetar el commit.' }
  New-Item -ItemType Directory -Path $stage | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $stage

  foreach ($required in @(
    'Dockerfile', 'package.json', 'src/server.js',
    'src/mesero-agente/agenteDelMesero.js',
    'scripts/predeploy-run-032-033.mjs'
  )) {
    if (!(Test-Path -LiteralPath ([IO.Path]::Combine($stage, $required)))) {
      throw "El commit empaquetado no contiene $required"
    }
  }

  $deployMessage = if ($Message) { "$commit $Message" } else { $commit }
  & railway up $stage --path-as-root --service $Service --ci --message $deployMessage
  if ($LASTEXITCODE -ne 0) { throw "Railway rechazó el despliegue de $commit" }
  Write-Host "Deploy completo del commit $commit"
}
finally {
  # Solo se eliminan las dos rutas literales que acabamos de crear dentro del
  # directorio temporal del sistema. La comprobación evita que una variable
  # dañada convierta la limpieza en un borrado fuera de ese espacio.
  $stageFull = [IO.Path]::GetFullPath($stage)
  $zipFull = [IO.Path]::GetFullPath($zip)
  if (!$stageFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or !$zipFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Se omitió la limpieza: las rutas temporales salieron del directorio esperado.'
  }
  if (Test-Path -LiteralPath $stageFull) { Remove-Item -LiteralPath $stageFull -Recurse -Force }
  if (Test-Path -LiteralPath $zipFull) { Remove-Item -LiteralPath $zipFull -Force }
}
