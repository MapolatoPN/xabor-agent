# Ciclo Claude Code + Codex en VS Code

Abre en VS Code la carpeta de la rama `rescue/mesero-tool-agent`. En
**Terminal → Run Task…** elige **Mesero: ciclo hasta listo para activar**.

Cada ronda hace tres pasos en orden:

1. Claude Code trabaja un bloqueo local concreto y deja sus archivos visibles
   en Source Control.
2. Corren las pruebas seguras del agente y la evaluación de guion.
3. Codex revisa los cambios en solo lectura y devuelve un dictamen estructurado.

Si Codex encuentra otra tarea local segura, la siguiente ronda la toma. El
ciclo se detiene al reunir evidencia de preparación, al encontrar un bloqueo
que necesita datos o una decisión externa, al completar cuatro rondas o al
superar tres horas entre rondas. El usuario puede detenerlo desde la terminal
de VS Code en cualquier momento.

Los registros se guardan en `.local-agent-runs/`, ignorado por Git. La clave
`ANTHROPIC_API_KEY` se retira de este proceso: Claude Code usa la sesión Max
iniciada. Las pruebas con modelo real requieren una ejecución separada y
explícita. Este ciclo no hace commit, push, merge, deploy ni activa banderas
de WhatsApp. `ready_for_activation` significa que puede revisarse la
activación, no que se haya activado.
