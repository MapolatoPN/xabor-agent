@echo off
title Deploy a Railway
color 0A
echo.
echo ================================================
echo   DEPLOY XABOR → RAILWAY
echo ================================================
echo.

cd /d "C:\xabor-agent"

echo [1/4] Eliminando locks de git si existen...
if exist ".git\index.lock" del /f ".git\index.lock"
if exist ".git\MERGE_HEAD" del /f ".git\MERGE_HEAD"

echo [2/4] Configurando identidad git...
git config user.email "mariocantuo79@gmail.com"
git config user.name "Mario Cantu"

echo [3/4] Haciendo commit...
git add src/services/database.js src/orders/orderManager.js src/server.js src/channels/whatsapp-meta.js panel/index.html panel/login.html panel/logo.png src/data/menu.json src/data/rules.json src/agent/prompts.js print-agent.js
git commit -m "feat: combo focaccia+ensalada; cierre anticipado 4pm; fix impresion"

echo [4/4] Subiendo a Railway...
git push origin main

echo.
if %ERRORLEVEL% == 0 (
  echo ✅ Deploy exitoso. Railway actualizara en ~1 minuto.
) else (
  echo ⚠️  Hubo un error. Revisa arriba.
)
echo.
pause
