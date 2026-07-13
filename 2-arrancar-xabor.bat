@echo off
cd /d "%~dp0"
echo Iniciando servidor Xabor...
start "Xabor Servidor" cmd /k "node src/server.js"
timeout /t 2 /nobreak >nul
echo Iniciando ngrok...
start "Xabor Ngrok" cmd /k "ngrok http 3000"
echo.
echo Listo. Panel en: http://localhost:3000
