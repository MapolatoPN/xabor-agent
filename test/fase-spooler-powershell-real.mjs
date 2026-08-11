// El script del spooler, ejecutado por un PowerShell DE VERDAD.
//
// Por qué existe: el script anterior era un bloque multilínea con
// `$ErrorActionPreference = "Stop"` y try/catch/finally. Alimentado por stdin
// (`powershell -Command -`), ese patrón puede salir con código 0 y stdout
// vacío: ni OK ni ERROR. El transporte lo clasificaba correctamente como
// SPOOLER_SIN_RESPUESTA, pero eso solo significaba "Windows no me dijo nada",
// y desde el mostrador era indistinguible de un problema de la impresora.
//
// El mismo patrón ya había roto la enumeración de impresoras. Lo arreglé allí
// y lo dejé intacto aquí, a dos archivos de distancia. Esta suite existe para
// que no haya una tercera vez.
//
// NO imprime nada físicamente: se ejecuta contra una impresora que no existe,
// lo cual ejercita OpenPrinter de verdad sin gastar papel. Que el ESC/POS salga
// bien en una térmica real es otra cosa, y solo lo demuestra el papel.
//
// En sistemas que no son Windows la suite se salta sola.
//
// Uso: node test/fase-spooler-powershell-real.mjs
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { crearTransporteWindowsSpooler, construirScript, interpretarSalida } from '../edge/transports/windowsSpooler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPRESORA_INEXISTENTE = 'XABOR-IMPRESORA-QUE-NO-EXISTE';

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ─── Lo que se puede comprobar en cualquier sistema ─────────────────────────

await t('1. el script NO usa el patrón que produce silencio', () => {
  const script = construirScript('CUALQUIERA', 'C:/tmp/x.bin');
  assert.ok(!script.includes('$ErrorActionPreference'),
    'ese ajuste, por stdin, hacía que el bloque saliera con 0 y sin salida');
  assert.ok(!/\btry\s*\{/.test(script),
    'el try/catch multilínea por stdin es justo lo que producía stdout vacío');
  assert.ok(!script.includes('\n'),
    'una sola línea: PowerShell procesa stdin como si se tecleara, y los bloques se pierden');
});

await t('2. el script conserva la secuencia Win32 completa y RAW', () => {
  const script = construirScript('CUALQUIERA', 'C:/tmp/x.bin');
  for (const fn of ['OpenPrinter', 'StartDocPrinter', 'StartPagePrinter', 'WritePrinter',
                    'EndPagePrinter', 'EndDocPrinter', 'ClosePrinter']) {
    assert.ok(script.includes(fn), `falta ${fn}`);
  }
  assert.ok(/pDataType = 'RAW'/.test(script),
    'sin RAW el driver reinterpreta el ESC/POS y sale basura impresa');
  assert.ok(!/Out-Printer/.test(script),
    'Out-Printer manda TEXTO: como respaldo de ESC/POS es peor que fallar');
});

await t('3. cada salida posible es reconocible, ninguna es silencio', () => {
  const script = construirScript('CUALQUIERA', 'C:/tmp/x.bin');
  for (const marca of ['ERROR:OPEN:', 'ERROR:STARTDOC:', 'ERROR:WRITE:', 'ERROR:PARCIAL:', 'ESCRIBIENDO', 'OK:']) {
    assert.ok(script.includes(marca), `el script nunca podría emitir ${marca}`);
  }
});

await t('4. los handles se cierran en TODOS los caminos de salida', () => {
  const script = construirScript('CUALQUIERA', 'C:/tmp/x.bin');
  // El fallo de StartDoc cierra la cola antes de salir.
  assert.ok(/ClosePrinter\(\$ph\) \| Out-Null; Write-Output \("ERROR:STARTDOC/.test(script),
    'si el spooler rechaza el documento hay que cerrar la impresora igual');
  // Y el camino de escritura cierra siempre, con éxito o sin él.
  const trasEscribir = script.slice(script.indexOf('WritePrinter'));
  assert.ok(trasEscribir.indexOf('ClosePrinter') < trasEscribir.indexOf('ERROR:WRITE'),
    'los handles se cierran ANTES de decidir si hubo error: un handle filtrado bloquea la cola');
});

// ─── Lo que solo se puede comprobar en Windows ──────────────────────────────

if (process.platform !== 'win32') {
  console.log('  --  el resto exige Windows: se omite en ' + process.platform);
} else {
  const rutaBytes = join(tmpdir(), `xabor-prueba-ps-${Date.now()}.bin`);
  writeFileSync(rutaBytes, Buffer.from([0x1b, 0x40, 0x48, 0x4f, 0x4c, 0x41, 0x0a]));

  try {
    await t('5. PowerShell REAL contra impresora inexistente -> ERROR:OPEN, nunca silencio', async () => {
      let salidaCruda = null;
      const transporte = crearTransporteWindowsSpooler({
        // Se envuelve el ejecutor real solo para poder mirar lo que devolvió.
        ejecutor: async (args) => {
          const r = await ejecutarDeVerdad(args);
          salidaCruda = r;
          return r;
        },
      });
      const r = await transporte.enviar(
        { config: { spoolerNombre: IMPRESORA_INEXISTENTE } },
        readFileSync(rutaBytes), {});

      assert.ok(salidaCruda, 'el ejecutor real tenía que correr');
      assert.notStrictEqual(salidaCruda.salida.trim(), '',
        'exit 0 + stdout vacío es EXACTAMENTE el fallo que esta prueba persigue');
      assert.match(salidaCruda.salida, /ERROR:OPEN:/,
        `Windows tiene que decir que no encontró la impresora; dijo: ${JSON.stringify(salidaCruda.salida.slice(0, 200))}`);

      // Y el transporte lo traduce a algo accionable, sin haber escrito nada.
      assert.strictEqual(r.resultado, 'fallido', 'no salió ni un byte: reintentar es seguro');
      assert.strictEqual(r.codigo, 'IMPRESORA_NO_DISPONIBLE');
      assert.ok(r.detalle && r.detalle.length > 0, 'con una explicación en castellano');
    });

    await t('6. el nombre con DOS espacios llega intacto al script', () => {
      const script = construirScript('POS Printer 203DPI  Series 2', rutaBytes);
      assert.ok(script.includes("$prn = 'POS Printer 203DPI  Series 2'"),
        'con un solo espacio, OpenPrinter no encuentra la cola');
    });

    await t('7. una comilla en el nombre no rompe ni inyecta', async () => {
      const r = await ejecutarDeVerdad({
        script: construirScript("Impresora'; Write-Output 'INYECTADO", rutaBytes),
        timeoutMs: 15000, alVerMarca: () => {},
      });
      assert.ok(!/INYECTADO/.test(r.salida), 'la comilla se escapa: no se ejecuta nada extra');
      assert.match(r.salida, /ERROR:OPEN:/, 'y sigue comportándose como un nombre inválido');
    });
  } finally {
    try { unlinkSync(rutaBytes); } catch { /* ya no está */ }
  }
}

// Ejecutor real: mismo comando y mismos argumentos que usa el transporte.
async function ejecutarDeVerdad({ script, timeoutMs = 20000, alVerMarca }) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true });
    let salida = '';
    const temporizador = setTimeout(() => { try { proc.kill(); } catch {} resolve({ salida, codigoSalida: -1, expiro: true }); }, timeoutMs);
    temporizador.unref?.();
    proc.stdout.on('data', (d) => { salida += d.toString(); if (salida.includes('ESCRIBIENDO')) alVerMarca?.(); });
    proc.stderr.on('data', (d) => { salida += d.toString(); });
    proc.on('error', (e) => { clearTimeout(temporizador); resolve({ salida, codigoSalida: -1, error: e.message }); });
    proc.on('close', (codigo) => { clearTimeout(temporizador); resolve({ salida, codigoSalida: codigo }); });
    proc.stdin.write(script); proc.stdin.end();
  });
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
process.exit(fallidas ? 1 : 0);
