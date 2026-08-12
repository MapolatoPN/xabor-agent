// El listado de impresoras, después de un reinicio de Windows.
//
// En Acuña, tras el primer reboot con el servicio instalado, Config →
// Impresoras devolvió `ok=false impresoras=0 error=timeout` mientras la
// impresión física funcionaba sin problema segundos después. Dos defectos
// distintos, y ninguno tenía que ver con la impresora:
//
//   1. Los timeouts estaban invertidos. La nube esperaba 6 s y el Edge tenía
//      8: quien aguarda la respuesta se rendía antes que quien la produce.
//      Aunque PowerShell contestara bien en el segundo 7, el panel ya había
//      dado el listado por perdido.
//
//   2. La impresora predeterminada iba en la MISMA consulta que la lista, y
//      se saca de WMI. El servicio Winmgmt se inicializa perezosamente y su
//      primera consulta tras un boot es la más lenta de la vida del equipo.
//      Un dato decorativo -- Xabor nunca imprime en la predeterminada --
//      tumbaba el listado entero.
//
// Uso: node test/fase-edge-discovery-timeouts.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const { listarImpresorasWindows } = await import('../edge/impresorasWindows.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const LISTA_OK = JSON.stringify([
  { nombre: 'POS Printer 203DPI  Series 2', estado: 'Normal', predeterminada: false },
  { nombre: 'Microsoft Print to PDF', estado: 'Normal', predeterminada: false },
]);

// ─── 1. El contrato entre los dos timeouts ──────────────────────────────────

await t('1. la nube espera MAS que el Edge', () => {
  const edge = readFileSync(join(RAIZ, 'edge', 'impresorasWindows.js'), 'utf8');
  const nube = readFileSync(join(RAIZ, 'src', 'server.js'), 'utf8');

  const tEdge = Number(/const TIMEOUT_MS = (\d+);/.exec(edge)?.[1]);
  const tNube = Number(/const TIMEOUT_IMPRESORAS_MS = (\d+);/.exec(nube)?.[1]);

  assert.ok(Number.isFinite(tEdge) && Number.isFinite(tNube),
    `no se pudieron leer los timeouts (edge=${tEdge} nube=${tNube})`);
  assert.ok(tNube > tEdge,
    `la nube (${tNube}ms) tiene que esperar mas que el Edge (${tEdge}ms): ` +
    'si se rinde antes, un listado que iba a llegar se pierde. Estuvieron al reves y costo un gate.');
});

await t('2. hay margen suficiente para un arranque en frio de PowerShell', () => {
  const edge = readFileSync(join(RAIZ, 'edge', 'impresorasWindows.js'), 'utf8');
  const tEdge = Number(/const TIMEOUT_MS = (\d+);/.exec(edge)?.[1]);
  assert.ok(tEdge >= 15000,
    `${tEdge}ms es poco: el primer powershell.exe tras un reboot paga el CLR desde disco frio`);
});

// ─── 2. La predeterminada, fuera del camino crítico ─────────────────────────

await t('3. si la consulta de la predeterminada EXPIRA, la lista sale igual', async () => {
  let llamadas = 0;
  const ejecutor = async () => {
    llamadas++;
    if (llamadas === 1) return { ok: true, salida: LISTA_OK };
    return { ok: false, error: 'timeout' };          // WMI dormido tras el boot
  };
  const r = await listarImpresorasWindows({ ejecutor, logger: null });
  assert.strictEqual(r.ok, true, 'un fallo al resolver la default NO puede tumbar el listado');
  assert.strictEqual(r.impresoras.length, 2, `se esperaban 2 impresoras y llegaron ${r.impresoras.length}`);
  assert.ok(r.impresoras.every((i) => i.predeterminada === false),
    'sin saber cual es la default, ninguna queda marcada -- y eso es correcto');
});

await t('4. si la consulta de la predeterminada LANZA, la lista sale igual', async () => {
  let llamadas = 0;
  const ejecutor = async () => {
    llamadas++;
    if (llamadas === 1) return { ok: true, salida: LISTA_OK };
    throw new Error('WMI no responde');
  };
  const r = await listarImpresorasWindows({ ejecutor, logger: null });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.impresoras.length, 2);
});

await t('5. cuando SI se resuelve, marca la correcta y solo esa', async () => {
  let llamadas = 0;
  const ejecutor = async () => {
    llamadas++;
    if (llamadas === 1) return { ok: true, salida: LISTA_OK };
    return { ok: true, salida: 'Microsoft Print to PDF\r\n' };
  };
  const r = await listarImpresorasWindows({ ejecutor, logger: null });
  const marcadas = r.impresoras.filter((i) => i.predeterminada);
  assert.strictEqual(marcadas.length, 1, 'una y solo una');
  assert.strictEqual(marcadas[0].nombre, 'Microsoft Print to PDF');
});

await t('6. la consulta de la lista ya no toca WMI', () => {
  const edge = readFileSync(join(RAIZ, 'edge', 'impresorasWindows.js'), 'utf8');
  // Todo lo que hay entre la constante de la lista y la de la predeterminada.
  const script = edge.slice(edge.indexOf('const SCRIPT_GET_PRINTER'),
                            edge.indexOf('const SCRIPT_DEFAULT'));
  assert.ok(!/Win32_Printer/.test(script),
    'WMI fuera del camino critico: su primera consulta tras un boot es la mas lenta del equipo');
  assert.ok(/Get-Printer/.test(script), 'pero la lista sigue saliendo de Get-Printer');
});

await t('7. un fallo de la LISTA si es un fallo, y no una lista vacia', async () => {
  const ejecutor = async () => ({ ok: false, error: 'timeout' });
  const r = await listarImpresorasWindows({ ejecutor, logger: null });
  assert.strictEqual(r.ok, false, 'esto si tiene que reportarse como fallo');
  assert.deepStrictEqual(r.impresoras, []);
  assert.ok(r.error, 'con un motivo, para que se pueda diagnosticar en sitio');
});

// ─── 3. El precalentamiento no puede estorbar ───────────────────────────────

await t('8. el warmup del arranque no se espera ni puede romperlo', () => {
  const idx = readFileSync(join(RAIZ, 'edge', 'index.js'), 'utf8');
  const bloque = /if \(conectar && process\.platform === 'win32'\) \{[\s\S]*?\n      \}/.exec(idx)?.[0] || '';
  assert.ok(bloque, 'no se encontro el bloque de precalentamiento en iniciar()');
  assert.ok(!/await\s+listarImpresorasWindows/.test(bloque),
    'sin await: el arranque, la autenticacion y la cola no pueden esperar por esto');
  assert.ok(/\.catch\(/.test(bloque),
    'con catch: un fallo del precalentamiento jamas puede tumbar el arranque del agente');

  // Y ocurre DESPUES de dejar el agente listo y de arrancar la conexion.
  const posListo = idx.indexOf("log.info('edge.listo'");
  const posWarm = idx.indexOf('impresoras.precalentado');
  assert.ok(posListo > 0 && posWarm > posListo,
    'el precalentamiento va despues de edge.listo: primero util, luego comodo');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach((f) => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
