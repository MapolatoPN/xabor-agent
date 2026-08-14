@echo off
REM Plantilla de variables LOCALES para dev-local.cmd. Copia este archivo a
REM dev-local.env.cmd (ignorado por git) y llena tus valores. Nunca uses
REM credenciales de produccion aqui: la DB debe ser la de pruebas en Docker.
set DATABASE_URL=postgresql://postgres:CAMBIA_ESTO@localhost:55453/edged1
set PANEL_SECRET=CAMBIA_ESTO
set SESSION_SECRET=CAMBIA_ESTO
set ADMIN_PASSWORD=CAMBIA_ESTO
set PANEL_PASSWORD=CAMBIA_ESTO
set INTEGRATIONS_ENCRYPTION_KEY=CAMBIA_ESTO
set META_EMBEDDED_SIGNUP_MOCK=true
