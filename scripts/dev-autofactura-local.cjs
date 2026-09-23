'use strict';
// `npm run dev:autofactura` — arranca Xabor en local con el entorno de
// autofactura (dev-local.env.cmd + base edged1_agrescate), tras diagnosticar
// el negocio de prueba, el módulo de facturación, la credencial de Facturapi
// y el puerto. Nunca imprime secretos; nunca mata procesos ajenos.
const { spawn, spawnSync } = require('child_process');
const {
  RAIZ, construirEntorno, imprimirResumen, pidEnPuerto, diagnosticar, imprimirDiagnostico,
} = require('./local-env-autofactura.cjs');

(async () => {
  const soloDiagnostico = process.argv.includes('--solo-diagnostico');
  const { env, resumen } = construirEntorno();
  imprimirResumen(resumen);

  const d = await diagnosticar(env);
  imprimirDiagnostico(d);
  if (!d.ok) {
    console.error('No se puede iniciar: corrige el negocio de prueba o su módulo de facturación (no se modifica nada automáticamente).');
    process.exit(1);
  }

  const puerto = Number(env.PORT) || 3000;
  const pid = await pidEnPuerto(puerto);
  if (pid) {
    console.error(`Puerto ${puerto} ocupado por PID ${pid}. Ciérralo antes de continuar.`);
    process.exit(2);
  }
  console.log(`PUERTO ${puerto}: LIBRE`);
  if (soloDiagnostico) return;

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const hijo = spawn(npm, ['start'], { cwd: RAIZ, env, stdio: 'inherit', shell: process.platform === 'win32' });
  const cerrar = () => {
    if (hijo.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(hijo.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else hijo.kill('SIGINT');
  };
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);
  hijo.on('exit', (code) => process.exit(code === null ? 0 : code));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
