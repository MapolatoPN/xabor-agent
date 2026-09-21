# Intercambio local del ciclo

El script `scripts/ai-loop.ps1` guarda cada ejecución en `runs/<fecha-id>/`:

- `goal.txt`: objetivo autorizado para esa ejecución.
- `initial-git-status.txt` y `iteration-N-git-status.txt`: estado del worktree antes y después de Claude.
- `iteration-N-claude.txt`: respuesta de Claude.
- `iteration-N-test-*.txt`: salida y código de salida de cada prueba.
- `iteration-N-review.json`: hallazgos estructurados de Codex.
- `iteration-N-codex-prompt.txt`: instrucciones de revisión.
- `summary.json`: estado final y ubicación de los resultados.

`runs/`, `active.lock` y `stop.requested` son locales y están ignorados por Git. No guardes claves ni datos de clientes en el objetivo. Lee [las instrucciones de uso](../docs/ai-loop-local.md) antes de iniciarlo.
