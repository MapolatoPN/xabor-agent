// Chequeo del predeploy: producción no se despliega sin sus secretos.
//
// Corre PRIMERO en predeploy-run-032-033.mjs, antes de cualquier migración.
// Si falla, Railway conserva el deployment anterior y no se toca el esquema.
// La misma regla la vuelve a aplicar el servidor al arrancar
// (src/services/guardaSecretos.js); este chequeo solo la adelanta.
//
// Imprime NOMBRES de variables, nunca valores.
import { revisarSecretos } from '../src/services/guardaSecretos.js';

const { productivo, bloqueantes, avisos } = revisarSecretos(process.env);

if (!productivo) {
  console.log('[predeploy-secretos] Entorno no productivo: no se exige nada.');
  process.exit(0);
}
for (const a of avisos) console.warn(`[predeploy-secretos] AVISO: ${a}`);
if (bloqueantes.length) {
  for (const b of bloqueantes) console.error(`[predeploy-secretos] FALLO: ${b}`);
  process.exit(1);
}
console.log('[predeploy-secretos] OK: secretos de producción presentes.');
process.exit(0);
