// Proceso aislado: los contratos importados por el gate prueban banderas de
// proceso y usan top-level await. No compartir esas banderas durante el test.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const r=spawnSync(process.execPath,[fileURLToPath(new URL('../test/fase-botones-elecciones.mjs',import.meta.url))],
  {encoding:'utf8',timeout:30000,windowsHide:true});
if(r.stdout)process.stdout.write(r.stdout);
if(r.stderr)process.stderr.write(r.stderr);
if(r.error || r.status !== 0)throw r.error || Error('Contrato de elecciones interactivas falló');
