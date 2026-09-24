'use strict';
// `npm run smoke:autofactura` — corre el smoke real controlado contra
// Facturapi TEST con EXACTAMENTE el mismo entorno que dev:autofactura
// (local-env-autofactura.cjs). Aborta antes de cualquier red si el negocio de
// prueba, su módulo o su credencial sk_test_ no están listos. La lógica del
// smoke (guardas, un solo POST, cero secretos) vive en
// scripts/smoke-autofactura-facturapi-test.mjs y no se duplica aquí.
const path = require('path');
const { spawn } = require('child_process');
const { RAIZ, construirEntorno, imprimirResumen, diagnosticar, imprimirDiagnostico } = require('./local-env-autofactura.cjs');

(async () => {
  const soloDiagnostico = process.argv.includes('--solo-diagnostico');
  const { env, resumen } = construirEntorno();
  imprimirResumen(resumen);

  const d = await diagnosticar(env);
  imprimirDiagnostico(d);
  if (!d.ok) {
    console.error('SMOKE ABORTADO antes de red: el negocio de prueba o su módulo de facturación no están listos.');
    process.exit(1);
  }
  if (d.facturapi !== 'CONFIGURADA') {
    console.error(`SMOKE ABORTADO antes de red: Facturapi ${d.facturapi}.`);
    process.exit(3);
  }
  if (soloDiagnostico) return;

  const hijo = spawn(process.execPath, [path.join(RAIZ, 'scripts', 'smoke-autofactura-facturapi-test.mjs')],
    { cwd: RAIZ, env, stdio: 'inherit' });
  hijo.on('exit', (code) => process.exit(code === null ? 1 : code));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
