import WebSocket from 'ws';
import { exec } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const WS_URL       = 'wss://xabor-agent-production.up.railway.app';
const PRINTER_NAME = 'POS Printer 203DPI  Series 2';  // doble espacio
const TEMP_DIR     = join(tmpdir(), 'xabor-comandas');
const ANCHO_PAPEL  = 42;

// ── ESC/POS byte helpers ──────────────────────────────────────────────────────
const ESC = 0x1B;
const GS  = 0x1D;
const LF  = 0x0A;

function b(...bytes) { return Buffer.from(bytes); }

const INIT         = b(ESC, 0x40);
// Densidad de calor: ESC 7 n1 n2 n3 — n2=160 → impresión oscura
const DARKNESS     = b(ESC, 0x37, 15, 160, 2);
const ALIGN_CENTER = b(ESC, 0x61, 1);
const ALIGN_LEFT   = b(ESC, 0x61, 0);
const ALIGN_RIGHT  = b(ESC, 0x61, 2);
const BOLD_ON      = b(ESC, 0x45, 1);
const BOLD_OFF     = b(ESC, 0x45, 0);
const SIZE_NORMAL  = b(GS, 0x21, 0x00);
const SIZE_2H      = b(GS, 0x21, 0x01);
const CUT          = b(GS, 0x56, 0x41, 0x03);

function lf(n = 1) { return Buffer.alloc(n, LF); }

// ── Formateo de texto ─────────────────────────────────────────────────────────
function linea(char = '-', ancho = ANCHO_PAPEL) {
  return char.repeat(ancho);
}

function columnas(izq, der, ancho = ANCHO_PAPEL) {
  const i = String(izq);
  const d = String(der);
  const spaces = Math.max(1, ancho - i.length - d.length);
  return i + ' '.repeat(spaces) + d;
}

function wrap(texto, ancho = ANCHO_PAPEL) {
  const palabras = String(texto).split(' ');
  const lineas = [];
  let actual = '';
  for (const p of palabras) {
    if (actual.length === 0) {
      actual = p;
    } else if (actual.length + 1 + p.length <= ancho) {
      actual += ' ' + p;
    } else {
      lineas.push(actual);
      actual = p;
    }
  }
  if (actual) lineas.push(actual);
  return lineas.join('\n');
}

// ── Construir buffer ESC/POS ──────────────────────────────────────────────────
function buildEscPos(pedido) {
  const partes = [];
  const txt = (s) => Buffer.from(String(s), 'latin1');

  partes.push(INIT);
  partes.push(DARKNESS);

  partes.push(ALIGN_CENTER);
  partes.push(SIZE_2H);
  partes.push(BOLD_ON);
  partes.push(txt('XABOR'));
  partes.push(lf());
  partes.push(SIZE_NORMAL);
  partes.push(BOLD_OFF);
  partes.push(txt('Piedras Negras, Coahuila'));
  partes.push(lf());
  partes.push(txt(linea('=')));
  partes.push(lf());

  partes.push(ALIGN_LEFT);
  partes.push(BOLD_ON);
  const folio = pedido.folio || pedido.id || 'S/N';
  partes.push(txt(`PEDIDO: ${folio}`));
  partes.push(lf());
  partes.push(BOLD_OFF);

  const ahora = new Date();
  const hora  = ahora.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const fecha = ahora.toLocaleDateString('es-MX');
  partes.push(txt(`Fecha: ${fecha}  Hora: ${hora}`));
  partes.push(lf());

  if (pedido.cliente)  { partes.push(txt(`Cliente: ${pedido.cliente}`));  partes.push(lf()); }
  if (pedido.telefono) { partes.push(txt(`Tel: ${pedido.telefono}`));      partes.push(lf()); }
  if (pedido.tipo) {
    partes.push(BOLD_ON);
    partes.push(txt(`Tipo: ${pedido.tipo.toUpperCase()}`));
    partes.push(BOLD_OFF);
    partes.push(lf());
  }

  partes.push(txt(linea('-')));
  partes.push(lf());

  partes.push(BOLD_ON);
  partes.push(txt(columnas('CANT  PRODUCTO', 'PRECIO')));
  partes.push(lf());
  partes.push(BOLD_OFF);
  partes.push(txt(linea('-')));
  partes.push(lf());

  const items = pedido.items || pedido.productos || [];
  let total = 0;
  for (const item of items) {
    const cant     = item.cantidad || item.qty || 1;
    const nombre   = item.nombre || item.name || item.producto || '';
    const precio   = parseFloat(item.precio || item.price || 0);
    const subtotal = cant * precio;
    total += subtotal;

    const etiqueta = `${cant}x  ${nombre}`;
    const monto    = `$${subtotal.toFixed(2)}`;
    partes.push(txt(columnas(etiqueta.slice(0, 34), monto)));
    partes.push(lf());

    const mods = item.modificadores || item.extras || item.notas || '';
    if (mods) {
      const modTexto  = typeof mods === 'string' ? mods : mods.join(', ');
      const lineasMod = wrap('  + ' + modTexto, ANCHO_PAPEL - 2).split('\n');
      for (const l of lineasMod) { partes.push(txt('  ' + l)); partes.push(lf()); }
    }
  }

  partes.push(txt(linea('=')));
  partes.push(lf());

  partes.push(ALIGN_RIGHT);
  partes.push(BOLD_ON);
  partes.push(SIZE_2H);
  const totalPedido = pedido.total || total;
  partes.push(txt(`TOTAL: $${parseFloat(totalPedido).toFixed(2)}`));
  partes.push(SIZE_NORMAL);
  partes.push(BOLD_OFF);
  partes.push(lf());
  partes.push(ALIGN_LEFT);

  if (pedido.notas || pedido.instrucciones) {
    const nota = pedido.notas || pedido.instrucciones;
    partes.push(txt(linea('-')));
    partes.push(lf());
    partes.push(BOLD_ON);
    partes.push(txt('NOTAS:'));
    partes.push(lf());
    partes.push(BOLD_OFF);
    const ls = wrap(nota, ANCHO_PAPEL).split('\n');
    for (const l of ls) { partes.push(txt(l)); partes.push(lf()); }
  }

  partes.push(txt(linea('=')));
  partes.push(lf());
  partes.push(ALIGN_CENTER);
  partes.push(txt('Gracias por su pedido!'));
  partes.push(lf());
  partes.push(txt('WhatsApp: (878) 000-0000'));
  partes.push(lf(3));
  partes.push(CUT);

  return Buffer.concat(partes);
}

// ── Imprimir via RAW Win32 (script .ps1 en archivo) ──────────────────────────
function buildPs1(binFile) {
  // Usamos array de líneas para evitar cualquier problema de escapado en JS
  const lines = [
    `Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public class RawPrint {`,
    `    [DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true)]`,
    `    public static extern bool OpenPrinter(string pName, out IntPtr phPrinter, IntPtr pDefault);`,
    `    [DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true)]`,
    `    public static extern int StartDocPrinter(IntPtr hPrinter, int Level, ref DOCINFO di);`,
    `    [DllImport("winspool.drv", SetLastError=true)]`,
    `    public static extern bool StartPagePrinter(IntPtr hPrinter);`,
    `    [DllImport("winspool.drv", SetLastError=true)]`,
    `    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);`,
    `    [DllImport("winspool.drv", SetLastError=true)]`,
    `    public static extern bool EndPagePrinter(IntPtr hPrinter);`,
    `    [DllImport("winspool.drv", SetLastError=true)]`,
    `    public static extern bool EndDocPrinter(IntPtr hPrinter);`,
    `    [DllImport("winspool.drv", SetLastError=true)]`,
    `    public static extern bool ClosePrinter(IntPtr hPrinter);`,
    `    [StructLayout(LayoutKind.Sequential)]`,
    `    public struct DOCINFO {`,
    `        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;`,
    `        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;`,
    `        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;`,
    `    }`,
    `}`,
    `"@`,
    `$prn = 'POS Printer 203DPI  Series 2'`,
    `$src = '${binFile}'`,
    `try {`,
    `    $bytes = [System.IO.File]::ReadAllBytes($src)`,
    `    $ph = [IntPtr]::Zero`,
    `    $ok = [RawPrint]::OpenPrinter($prn, [ref]$ph, [IntPtr]::Zero)`,
    `    if (-not $ok) {`,
    `        $e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()`,
    `        Write-Output "ERROR:OpenPrinter Win32=$e"`,
    `        exit 1`,
    `    }`,
    `    $di = New-Object RawPrint+DOCINFO`,
    `    $di.pDocName  = 'Comanda'`,
    `    $di.pDataType = 'RAW'`,
    `    $job = [RawPrint]::StartDocPrinter($ph, 1, [ref]$di)`,
    `    if ($job -le 0) {`,
    `        $e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()`,
    `        Write-Output "ERROR:StartDocPrinter Win32=$e"`,
    `        [RawPrint]::ClosePrinter($ph) | Out-Null`,
    `        exit 1`,
    `    }`,
    `    [RawPrint]::StartPagePrinter($ph) | Out-Null`,
    `    $written = 0`,
    `    [RawPrint]::WritePrinter($ph, $bytes, $bytes.Length, [ref]$written) | Out-Null`,
    `    [RawPrint]::EndPagePrinter($ph) | Out-Null`,
    `    [RawPrint]::EndDocPrinter($ph) | Out-Null`,
    `    [RawPrint]::ClosePrinter($ph) | Out-Null`,
    `    Write-Output "OK:$written"`,
    `} catch {`,
    `    Write-Output "ERROR:$_"`,
    `}`,
  ];
  return lines.join('\r\n');
}

function imprimirComanda(pedido) {
  try {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

    const folio   = pedido.folio || pedido.id || Date.now();
    const binFile = join(TEMP_DIR, `comanda-${folio}.bin`);
    const psFile  = join(TEMP_DIR, `print-${folio}.ps1`);

    const buf = buildEscPos(pedido);
    writeFileSync(binFile, buf);
    console.log(`[IMPRIMIR] Folio ${folio} → ${buf.length} bytes ESC/POS`);

    // Escribir script PS1 a archivo (sin triple-escaping)
    writeFileSync(psFile, buildPs1(binFile), 'utf8');

    const cmd = `powershell -ExecutionPolicy Bypass -NonInteractive -File "${psFile}"`;
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      const out = (stdout || '').trim();

      if (stderr && stderr.trim()) {
        console.warn('[PS1 stderr]', stderr.trim().slice(0, 400));
      }
      if (err) {
        console.error('[ERROR] PS1:', err.message.slice(0, 200));
        runFallback(binFile);
        return;
      }

      console.log('[RAW] resultado:', out || '(vacío)');

      if (out.startsWith('OK:')) {
        const bytes = parseInt(out.slice(3), 10);
        if (bytes > 0) {
          console.log(`[OK] RAW Win32 → ${bytes} bytes enviados a impresora`);
          return;
        }
        console.warn('[WARN] RAW OK pero 0 bytes escritos');
      } else if (out.startsWith('ERROR:')) {
        console.warn('[WARN] RAW error:', out);
      } else {
        console.warn('[WARN] RAW respuesta inesperada:', out || '(vacío)');
      }

      runFallback(binFile);
    });

  } catch (e) {
    console.error('[ERROR] imprimirComanda:', e.message);
  }
}

function runFallback(archivoBin) {
  console.log('[FALLBACK] Usando Out-Printer (texto plano)...');
  exec(
    `powershell -Command "Get-Content '${archivoBin}' | Out-Printer -Name '${PRINTER_NAME}'"`,
    (err) => {
      if (err) console.error('[ERROR] Fallback Out-Printer:', err.message.slice(0, 200));
      else     console.log('[OK] Fallback Out-Printer OK');
    }
  );
}

// ── WebSocket con reconexión automática ───────────────────────────────────────
let ws;
let espera = 5;

function conectar() {
  console.log(`[WS] Conectando a ${WS_URL}...`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    espera = 5;
    console.log('[WS] Conectado al servidor Railway OK');
    ws.send(JSON.stringify({ tipo: 'agente', rol: 'impresora', restaurante: 'xabor' }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[MSG] tipo=${msg.tipo}`);
      if (msg.tipo === 'nuevo_pedido') {
        console.log('[PEDIDO JSON]', JSON.stringify(msg.pedido, null, 2));
        console.log(`[PEDIDO] ${msg.pedido?.folio || msg.pedido?.id}`);
        imprimirComanda(msg.pedido);
      }
    } catch (e) {
      console.warn('[WS] Mensaje no JSON:', data.toString().slice(0, 100));
    }
  });

  ws.on('close', (code) => {
    console.warn(`[WS] Desconectado (${code}). Reintento en ${espera}s...`);
    setTimeout(conectar, espera * 1000);
    espera = Math.min(espera * 2, 60);
  });

  ws.on('error', (e) => {
    console.error('[WS] Error:', e.message);
  });
}

conectar();
