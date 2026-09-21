# Ciclo local Claude → pruebas → Codex → corrección

Este ciclo trabaja sólo en el worktree `C:\xabor-agent\.claude\worktrees\peaceful-blackwell-ebf703`, rama `rescue/mesero-tool-agent`. Claude edita y Codex revisa en modo de solo lectura, uno después del otro. No hay comandos de despliegue, merge, push, commit ni activación de canario. El máximo es tres iteraciones.

## Comprobar antes de gastar llamadas

Abre la terminal PowerShell de VS Code en ese worktree y ejecuta:

```powershell
npm.cmd run ai:loop
```

Éste es el modo `Check` predeterminado: busca `claude`, `codex` y `node`, lee sus ayudas y verifica los flags usados. No llama a ningún modelo ni ejecuta pruebas. El `claude.exe` de esta máquina se encontró en WinGet aunque no figura en el PATH; el script también comprueba esa ubicación. Si cambian las versiones y falta un flag, se detiene antes del ciclo.

## Iniciar, sólo después de autorizar el coste

Deja inactivas las sesiones manuales de Claude y Codex que usen este mismo worktree. Escribe un objetivo concreto, sin claves ni datos de clientes:

```powershell
npm.cmd run ai:loop -- -Action Run -Goal "DESCRIBE AQUÍ EL CAMBIO LOCAL"
```

`-Action Run` es la acción explícita que permite llamadas a ambos modelos. Puedes limitarlo más con `-MaxIterations 1` o `2`; el valor predeterminado y máximo es `3`. Claude corre en modo seguro, con herramientas de lectura y edición, sin herramientas de comandos. Tras cada turno de Claude, el script ejecuta `test/fase-agente-tools.mjs` y `test/replay-mesero.mjs`, dos suites locales deterministas sin red, base de datos ni API key. El script quita credenciales del entorno sólo durante esas pruebas. Después Codex revisa el árbol sin commit y los logs con `codex exec --sandbox read-only`. Si hay hallazgos o fallan pruebas, Claude recibe sus archivos de intercambio para la siguiente corrección.

El script usa un bloqueo local para evitar dos ciclos simultáneos. No controla sesiones abiertas fuera de él; mantén inactivas las sesiones manuales en este worktree mientras corre. Conserva los cambios ya existentes y deja todo sin commit para revisión humana.

## Detener y revisar

Para detener la fase actual inmediatamente, pulsa `Ctrl+C` en la terminal donde corre el ciclo. Para pedir que se detenga entre fases, desde otra terminal del mismo worktree ejecuta:

```powershell
npm.cmd run ai:loop -- -Action Stop
```

Consulta el último estado con:

```powershell
npm.cmd run ai:loop -- -Action Status
```

Abre `.ai-loop/runs/<fecha-id>/summary.json`. Allí están `goal.txt`, las respuestas de Claude, cada log de prueba y `iteration-N-review.json`. Revisa además `git status` y el diff en Source Control de VS Code. No integres ni despliegues basándote sólo en el resultado del ciclo. Si la terminal se cerró bruscamente y queda `.ai-loop/active.lock`, comprueba que el proceso ya terminó antes de borrar ese archivo manualmente.
