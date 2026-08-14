@echo off
REM Servidor LOCAL para desarrollo (DB de pruebas Docker, NUNCA produccion).
REM Los secretos NO viven en este archivo: se cargan de dev-local.env.cmd,
REM que esta en .gitignore. Copia dev-local.env.example.cmd para crearlo.
cd /d C:\xabor-print
if not exist dev-local.env.cmd (
  echo [dev-local] Falta dev-local.env.cmd. Copia dev-local.env.example.cmd,
  echo [dev-local] renombralo a dev-local.env.cmd y llena los valores locales.
  exit /b 1
)
call dev-local.env.cmd
set PORT=4500
node src/server.js
