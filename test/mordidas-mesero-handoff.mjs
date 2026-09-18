// Fallos deliberados en copia temporal; nunca modifica el checkout de trabajo.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const copia = mkdtempSync(join(tmpdir(), 'xabor-handoff-mordidas-'));
try {
  cpSync(join(raiz,'src'), join(copia,'src'), {recursive:true});
  cpSync(join(raiz,'test/fase-mesero-handoff-sombra.mjs'), join(copia,'test/fase-mesero-handoff-sombra.mjs'));
  cpSync(join(raiz,'package.json'), join(copia,'package.json'));
  const archivo = join(copia,'src/mesero-whatsapp/handoffDeSombra.js');
  const original = readFileSync(archivo,'utf8');
  const ejecutar = () => spawnSync(process.execPath,['test/fase-mesero-handoff-sombra.mjs'],
    {cwd:copia, encoding:'utf8', timeout:30000});
  assert.equal(ejecutar().status, 0, 'La copia debe arrancar verde');
  const puerta = '  const listo = !!propuesta && artefacto.bloqueos.length === 0 && confirmadoAhora;';
  const mutaciones = [
    ['SH1', puerta, '  const listo = !!propuesta && artefacto.bloqueos.length === 0;', ['S3']],
    ['SH2', "  const confirmadoAhora = resultado?.fase === 'confirmando';",
      "  const confirmadoAhora = resultado?.fase === 'confirmando' || !!resultado?.listoParaConfirmar;", ['S14']],
    ['SH3', '  const propuesta = artefacto.propuesta;', `  const propuesta = artefacto.propuesta;
      if (propuesta) for (const c of ['negocioId','canal','telefono_conversacion']) {
        if (resultado?.carrito?.datos?.[c]) propuesta[c] = resultado.carrito.datos[c];
      }`, ['S7','S8','S9']],
    ['SH4', '  const propuesta = artefacto.propuesta;',
      '  const propuesta = artefacto.propuesta; if (propuesta) propuesta.total = 215;', ['S13']],
    ['SH5', puerta, '  const listo = !!propuesta && (handoffPrevio ? true : (artefacto.bloqueos.length === 0 && confirmadoAhora));', ['S17']],
    ['SH6', '      (i.modificadores || []).map((m)', '      ([]).map((m)', ['S16']],
    // No se ejecuta la dependencia: el detector debe descubrirla en el grafo.
    ['SH7', "import { createHash } from 'node:crypto';",
      "import { createHash } from 'node:crypto';\nif (false) await import('../orders/orderManager.js');", ['S22/S23']],
    ['SH8', '    tel_conv: p?.telefono_conversacion ? hash10(p.telefono_conversacion) : null,',
      '    tel_conv: p?.telefono_conversacion || null,', ['S27']],
  ];
  for (const [nombre, de, a, casos] of mutaciones) {
    assert.equal(original.split(de).length, 2, `${nombre}: ancla única`);
    writeFileSync(archivo,original.replace(de,a));
    const r = ejecutar();
    assert.equal(r.status, 1, `${nombre}: debe fallar por aserciones: ${r.stderr}`);
    for (const caso of casos) assert.ok(r.stdout.includes(`> FALLO ${caso}.`), `${nombre}: no cayó ${caso}\n${r.stdout}`);
    writeFileSync(archivo,original);
    assert.equal(ejecutar().status, 0, `${nombre}: restauración verde`);
    console.log(`${nombre}: detectada (${casos.join(', ')}); restauración verde`);
  }
} finally { rmSync(copia,{recursive:true,force:true}); }
