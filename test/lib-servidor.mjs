// Arranca/detiene src/server.js como proceso hijo para las suites que
// necesitan un servidor HTTP real (Fase B). No usa la exportación del
// propio server.js (que llama app.listen top-level) -- child_process
// mantiene cada suite independiente y permite variar env vars por
// arranque (p. ej. ALLOW_MANUAL_INTEGRATION_CREDENTIALS).
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');

export async function arrancarServidor(envExtra, { timeoutMs = 15000, omitir = [] } = {}) {
  const env = { ...process.env, ...envExtra };
  for (const clave of omitir) delete env[clave];
  const proc = spawn(process.execPath, [join(RAIZ, 'src', 'server.js')], {
    cwd: RAIZ,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  proc.stdout.on('data', d => { salida += d.toString(); });
  proc.stderr.on('data', d => { salida += d.toString(); });

  const puerto = envExtra.PORT || process.env.PORT || '3000';
  const base = `http://localhost:${puerto}`;
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return { proc, base, detener: () => proc.kill(), obtenerSalida: () => salida };
    } catch { /* aún no levanta */ }
    await new Promise(r => setTimeout(r, 300));
  }
  proc.kill();
  throw new Error(`El servidor no respondió /health en ${timeoutMs}ms.\nSalida:\n${salida.slice(-2000)}`);
}
