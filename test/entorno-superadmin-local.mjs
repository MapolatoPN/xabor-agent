import './solo-db-pruebas.mjs';
// Este entorno es exclusivamente local. No reutiliza secretos de una sesión
// de despliegue y todos los proveedores permanecen bloqueados por el preload.
Object.assign(process.env, {
  NODE_ENV: 'test',
  SESSION_SECRET: 'superadmin-qa-local-session-no-produccion',
  PANEL_SECRET: 'superadmin-qa-local-panel-no-produccion',
  ADMIN_PASSWORD: 'superadmin-qa-local-admin-no-produccion',
  INTEGRATIONS_ENCRYPTION_KEY: '52'.repeat(32),
  ANTHROPIC_API_KEY: 'qa_sin_proveedor_externo',
  OPENAI_API_KEY: 'qa_sin_proveedor_externo',
  XABOR_CONCILIACION_AUTOMATICA: 'false',
});
if (!(process.env.NODE_OPTIONS || '').includes('red-solo-local')) throw new Error('Se exige el bloqueo de proveedores externos para las pruebas de Superadmin');
