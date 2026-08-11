import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
const { cargarConfig } = await import('../edge/config.js');
const base = mkdtempSync(join(tmpdir(), 'xabor-pd-'));
mkdirSync(join(base, 'config'), { recursive: true });
writeFileSync(join(base, 'config', 'config.json'), JSON.stringify({
  terminalId: 'TID-123', terminalToken: 'TOK-456',
  urlNube: 'wss://xabor.mx/ws/print-agent', nombreEquipo: 'Caja',
}));
const c = cargarConfig({ env: { XABOR_EDGE_PROGRAMDATA: base }, rutaEnv: '/nope' });
assert.strictEqual(c.terminalId, 'TID-123');
assert.strictEqual(c.terminalToken, 'TOK-456');
assert.strictEqual(c.urlNube, 'wss://xabor.mx/ws/print-agent');
assert.strictEqual(c.rutaDatos, join(base, 'data'), 'la cola vive en ProgramData');
const forzado = cargarConfig({ env: { XABOR_EDGE_PROGRAMDATA: base, XABOR_TERMINAL_ID: 'OVERRIDE' }, rutaEnv: '/nope' });
assert.strictEqual(forzado.terminalId, 'OVERRIDE', 'el entorno explicito manda sobre el JSON');
rmSync(base, { recursive: true, force: true });
console.log('OK: el servicio lee config.json de ProgramData, la cola queda ahi, y el entorno explicito sigue mandando');
