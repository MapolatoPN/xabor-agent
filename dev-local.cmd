@echo off
REM Servidor LOCAL para la reingenieria UX (DB de pruebas Docker, NUNCA produccion).
cd /d C:\xabor-print
set DATABASE_URL=postgresql://postgres:testpass@localhost:55453/edged1
set PANEL_SECRET=test-panel-secret-fixed
set SESSION_SECRET=test-session-secret-fixed
set ADMIN_PASSWORD=test-admin-pass
set PANEL_PASSWORD=test-panel-pass
set INTEGRATIONS_ENCRYPTION_KEY=z+QXvnnTVTsL3HCrY/siK6VHJW4JmpH9BPcTl8oYs8U=
set META_EMBEDDED_SIGNUP_MOCK=true
set PORT=4500
node src/server.js
