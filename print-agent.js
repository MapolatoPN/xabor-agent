import WebSocket from 'ws';
import { exec } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync, copyFileSync } from 'fs';
import { join, dirname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = join(tmpdir(), 'xabor-comandas');

// ── Configuración resuelta al arrancar (ver resolverConfig/validarConfig/
// main más abajo) -- nunca hardcodeada, nunca con terminalId/token por
// defecto. ANCHO_PAPEL sí tiene un valor por defecto razonable (42) si no
// se define XABOR_ANCHO_PAPEL, igual que antes de esta fase. ──────────────
let WS_URL = '';
let TERMINAL_ID = '';
let TERMINAL_TOKEN = '';
let PRINTER_NAME = '';
let ANCHO_PAPEL = 42;

// Deduplicación persistente por printJobId -- sobrevive reinicios del
// agente. Ruta configurable vía XABOR_DEDUP_FILE; por defecto vive junto a
// este script.
const DEDUP_FILE = process.env.XABOR_DEDUP_FILE || join(__dirname, '.print-agent-jobs.json');
const DEDUP_VENTANA_DIAS = 7;
const DEDUP_LIMITE_JOBS = 1000;

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
// Sin cambios de formato en esta fase -- misma comanda, mismo ancho, mismo
// corte, mismo encoding.
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

// Escapa un valor para insertarlo dentro de una cadena de PowerShell entre
// comillas simples (duplicar comillas simples es el escape estándar de PS1).
function escaparPs1(s) {
  return String(s).replace(/'/g, "''");
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
    // ⚠ Antes de esta fase este valor estaba hardcodeado aquí, independiente
    // de la constante PRINTER_NAME (que solo aplicaba al fallback Out-Printer
    // más abajo). Se corrige para usar la configuración real -- de lo
    // contrario XABOR_PRINTER_NAME no tendría efecto sobre la ruta RAW
    // principal, que es la que se usa primero.
    `$prn = '${escaparPs1(PRINTER_NAME)}'`,
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

function runFallback(archivoBin) {
  return new Promise((resolve) => {
    console.log('[FALLBACK] Usando Out-Printer (texto plano)...');
    exec(
      `powershell -Command "Get-Content '${archivoBin}' | Out-Printer -Name '${PRINTER_NAME}'"`,
      (err) => {
        if (err) {
          console.error('[ERROR] Fallback Out-Printer:', err.message.slice(0, 200));
          resolve({ ok: false, detalle: 'fallback Out-Printer falló' });
        } else {
          console.log('[OK] Fallback Out-Printer OK');
          resolve({ ok: true, detalle: 'fallback Out-Printer' });
        }
      }
    );
  });
}

// Envío físico real: PS1 RAW Win32, con fallback a Out-Printer -- misma
// lógica y los mismos comandos que existían antes de esta fase, solo
// envueltos en una Promise (en vez de fire-and-forget) para poder marcar el
// trabajo como 'impreso' o 'fallido' en la deduplicación persistente.
function ejecutarImpresionFisicaReal(binFile) {
  return new Promise((resolve) => {
    const psFile = binFile.replace(/\.bin$/, '.ps1');
    writeFileSync(psFile, buildPs1(binFile), 'utf8');

    const cmd = `powershell -ExecutionPolicy Bypass -NonInteractive -File "${psFile}"`;
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      const out = (stdout || '').trim();

      if (stderr && stderr.trim()) {
        console.warn('[PS1 stderr]', stderr.trim().slice(0, 400));
      }
      if (err) {
        console.error('[ERROR] PS1:', err.message.slice(0, 200));
        runFallback(binFile).then(resolve);
        return;
      }

      console.log('[RAW] resultado:', out || '(vacío)');

      if (out.startsWith('OK:')) {
        const bytes = parseInt(out.slice(3), 10);
        if (bytes > 0) {
          console.log(`[OK] RAW Win32 → ${bytes} bytes enviados a impresora`);
          resolve({ ok: true, detalle: `RAW ${bytes} bytes` });
          return;
        }
        console.warn('[WARN] RAW OK pero 0 bytes escritos');
      } else if (out.startsWith('ERROR:')) {
        console.warn('[WARN] RAW error:', out);
      } else {
        console.warn('[WARN] RAW respuesta inesperada:', out || '(vacío)');
      }

      runFallback(binFile).then(resolve);
    });
  });
}

// Inyectable exclusivamente para pruebas (mismo patrón ya usado en
// printRouter.js: setBroadcastsImpresion / setDependenciasImpresionParaPruebas)
// -- evita depender de una impresora física o de invocar PowerShell real en
// cada corrida de pruebas. El valor por defecto es SIEMPRE la
// implementación real de arriba; producción nunca llama a este setter.
let _ejecutarImpresionFisica = ejecutarImpresionFisicaReal;
export function setEjecutorImpresionParaPruebas(fn) {
  if (typeof fn !== 'function') {
    throw new Error('setEjecutorImpresionParaPruebas: se requiere una función');
  }
  _ejecutarImpresionFisica = fn;
}

async function imprimirComanda(pedido) {
  try {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

    const folio   = pedido.folio || pedido.id || Date.now();
    const binFile = join(TEMP_DIR, `comanda-${folio}.bin`);

    const buf = buildEscPos(pedido);
    writeFileSync(binFile, buf);
    console.log(`[IMPRIMIR] Folio ${folio} → ${buf.length} bytes ESC/POS`);

    return await _ejecutarImpresionFisica(binFile);
  } catch (e) {
    console.error('[ERROR] imprimirComanda:', e.message);
    return { ok: false, detalle: e.message };
  }
}

// ─── Deduplicación persistente por printJobId ────────────────────────────────
// Un trabajo ya reservado/impreso/fallido nunca se reprocesa, ni siquiera
// tras reiniciar el agente o reconectar. Escritura atómica (archivo
// temporal + rename). Si el archivo está corrupto o tiene una forma
// inesperada: se respalda, se registra el error y se inicia vacío -- una
// decisión deliberada (documentada aquí): los nuevos trabajos entrantes
// siempre pasan por el flujo normal reservar→imprimir→marcar, que es la
// propia protección contra doble impresión; perder el historial de
// deduplicación no reimprime nada por sí solo, solo deja de "recordar"
// trabajos anteriores a la corrupción.
//
// Esta estrategia (iniciar vacío tras corrupción) depende de que el
// servidor NUNCA reenvíe trabajos ya emitidos ni envíe un snapshot al
// conectar/reconectar -- que es el comportamiento actual de
// /ws/print-agent (ver server.js: sin snapshot, cada nuevo_pedido se
// emite una sola vez cuando ocurre). Si en el futuro el servidor
// implementara algún reenvío o cola de trabajos pendientes, esta
// estrategia de "iniciar vacío" dejaría de ser segura (un trabajo ya
// impreso antes de la corrupción podría reenviarse y ya no habría
// registro para detectarlo como duplicado) y debería revisarse --
// por ejemplo, negándose a procesar hasta confirmar el estado con el
// servidor, en vez de asumir que todo lo entrante es nuevo.
let _dedupCache = null;

function _dedupVacio() { return { jobs: {} }; }

function respaldarArchivoCorrupto() {
  try {
    const destino = `${DEDUP_FILE}.corrupto-${Date.now()}.bak`;
    copyFileSync(DEDUP_FILE, destino);
    console.error(`[Dedup] Respaldo del archivo corrupto creado en ${destino}`);
  } catch (e) {
    console.error('[Dedup] No se pudo respaldar el archivo corrupto:', e.message);
  }
}

function cargarDedup() {
  if (_dedupCache) return _dedupCache;
  if (!existsSync(DEDUP_FILE)) {
    _dedupCache = _dedupVacio();
    return _dedupCache;
  }
  try {
    const raw = readFileSync(DEDUP_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !parsed.jobs || typeof parsed.jobs !== 'object' || Array.isArray(parsed.jobs)) {
      throw new Error('estructura inesperada (se esperaba { jobs: {...} })');
    }
    _dedupCache = parsed;
  } catch (e) {
    console.error(`[Dedup] Archivo de deduplicación corrupto o ilegible (${e.message}) -- se respalda y se inicia vacío`);
    respaldarArchivoCorrupto();
    _dedupCache = _dedupVacio();
  }
  return _dedupCache;
}

function limpiarJobsAntiguos(data) {
  const corte = Date.now() - DEDUP_VENTANA_DIAS * 24 * 60 * 60 * 1000;
  let entradas = Object.entries(data.jobs).filter(([, v]) => {
    const t = Date.parse(v?.ts);
    return !Number.isNaN(t) && t >= corte;
  });
  if (entradas.length > DEDUP_LIMITE_JOBS) {
    entradas.sort((a, b2) => Date.parse(a[1].ts) - Date.parse(b2[1].ts));
    entradas = entradas.slice(entradas.length - DEDUP_LIMITE_JOBS);
  }
  data.jobs = Object.fromEntries(entradas);
}

function guardarDedup() {
  const tmp = DEDUP_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(_dedupCache, null, 2), 'utf8');
  renameSync(tmp, DEDUP_FILE);
}

function obtenerEstadoJob(printJobId) {
  return cargarDedup().jobs[printJobId] || null;
}
function reservarJob(printJobId) {
  const data = cargarDedup();
  data.jobs[printJobId] = { estado: 'procesando', ts: new Date().toISOString() };
  limpiarJobsAntiguos(data);
  guardarDedup();
}
function marcarJobImpreso(printJobId) {
  const data = cargarDedup();
  data.jobs[printJobId] = { estado: 'impreso', ts: new Date().toISOString() };
  guardarDedup();
}
function marcarJobFallido(printJobId) {
  const data = cargarDedup();
  data.jobs[printJobId] = { estado: 'fallido', ts: new Date().toISOString() };
  guardarDedup();
}
// Exclusivo para pruebas: fuerza a que la próxima llamada relea el archivo
// de deduplicación en vez de usar el caché en memoria del proceso.
export function _resetDedupCacheParaPruebas() { _dedupCache = null; }

// ─── Configuración ────────────────────────────────────────────────────────────
export function resolverConfig() {
  const wsUrlRaw       = process.env.XABOR_WS_URL || '';
  const terminalId     = process.env.XABOR_TERMINAL_ID || '';
  const terminalToken  = process.env.XABOR_TERMINAL_TOKEN || '';
  const printerName    = process.env.XABOR_PRINTER_NAME || '';
  const anchoRaw       = process.env.XABOR_ANCHO_PAPEL;
  const anchoParseado  = anchoRaw ? parseInt(anchoRaw, 10) : NaN;
  const anchoPapel     = Number.isFinite(anchoParseado) && anchoParseado > 0 ? anchoParseado : 42;
  return { wsUrlRaw, terminalId, terminalToken, printerName, anchoPapel };
}

// Nunca incluye el valor del token -- solo el nombre de la variable
// faltante. No usar en logs nada más que este arreglo de mensajes.
export function validarConfig(cfg) {
  const errores = [];
  if (typeof cfg.terminalId !== 'string' || cfg.terminalId === '') {
    errores.push('XABOR_TERMINAL_ID no configurado');
  }
  if (typeof cfg.terminalToken !== 'string' || cfg.terminalToken === '') {
    errores.push('XABOR_TERMINAL_TOKEN no configurado');
  }
  if (typeof cfg.printerName !== 'string' || cfg.printerName === '') {
    errores.push('XABOR_PRINTER_NAME no configurado');
  }
  let urlValida = false;
  if (typeof cfg.wsUrlRaw === 'string' && cfg.wsUrlRaw !== '') {
    try { new URL(cfg.wsUrlRaw); urlValida = true; } catch { /* inválida */ }
  }
  if (!urlValida) {
    errores.push('XABOR_WS_URL no configurado o no es una URL válida');
  }
  return errores;
}

// Si XABOR_WS_URL ya termina en /ws/print-agent, se usa tal cual; si es un
// dominio/base, se agrega la ruta. Nunca se conecta a la raíz legacy.
export function construirUrlAutenticada(base) {
  const sinBarraFinal = base.replace(/\/+$/, '');
  return sinBarraFinal.endsWith('/ws/print-agent') ? sinBarraFinal : `${sinBarraFinal}/ws/print-agent`;
}

// ─── Procesamiento de trabajos ────────────────────────────────────────────────
// Solo se llama ya autenticado (ver conectar() más abajo). Válida
// estrictamente antes de tocar la deduplicación o imprimir; nunca confía
// solo en tipoDocumento -- exige que printJobId coincida exactamente con
// `${pedido.id}:comanda`.
export async function procesarTrabajo(msg) {
  const { printJobId, tipoDocumento, pedido } = msg || {};

  if (typeof printJobId !== 'string' || printJobId === '') {
    console.error('[Job] printJobId inválido -- ignorado');
    return { procesado: false, razon: 'printJobId_invalido' };
  }
  if (tipoDocumento !== 'comanda') {
    console.error(`[Job] tipoDocumento inesperado -- ignorado printJobId=${printJobId}`);
    return { procesado: false, razon: 'tipoDocumento_invalido' };
  }
  if (pedido === null || typeof pedido !== 'object' || Array.isArray(pedido)) {
    console.error(`[Job] pedido inválido -- ignorado printJobId=${printJobId}`);
    return { procesado: false, razon: 'pedido_invalido' };
  }
  if (typeof pedido.id !== 'string' || pedido.id === '' || printJobId !== `${pedido.id}:comanda`) {
    console.error(`[Job] printJobId no coincide con pedido.id -- ignorado printJobId=${printJobId}`);
    return { procesado: false, razon: 'printJobId_no_coincide' };
  }

  const estadoPrevio = obtenerEstadoJob(printJobId);
  if (estadoPrevio) {
    console.log(`[Job] printJobId=${printJobId} ya registrado (estado=${estadoPrevio.estado}) -- no se reimprime`);
    return { procesado: false, razon: 'ya_procesado' };
  }

  reservarJob(printJobId);
  console.log(`[Job] Imprimiendo printJobId=${printJobId} folio=${pedido.id}`);
  const resultado = await imprimirComanda(pedido);
  if (resultado.ok) {
    marcarJobImpreso(printJobId);
    console.log(`[Job] printJobId=${printJobId} impreso OK`);
    return { procesado: true, razon: 'impreso' };
  }
  marcarJobFallido(printJobId);
  console.error(`[Job] printJobId=${printJobId} FALLÓ -- no se reintentará automáticamente (intervención manual futura)`);
  return { procesado: false, razon: 'error_impresion' };
}

// ── WebSocket con autenticación por terminal y reconexión ────────────────────
let ws = null;
let autenticado = false;
let espera = 5; // segundos -- mínimo 5, máximo 60, se reinicia SOLO tras autenticación exitosa

function conectar() {
  console.log(`[WS] Conectando a ${WS_URL}...`);
  autenticado = false;
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[WS] Conexión abierta -- enviando credenciales de terminal');
    // Exactamente un mensaje de autenticación por conexión. Nunca en la URL,
    // query string ni headers -- solo en este primer mensaje.
    ws.send(JSON.stringify({ tipo: 'autenticar_terminal', terminalId: TERMINAL_ID, token: TERMINAL_TOKEN }));
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // mensaje no JSON -- se ignora, nunca se procesa como trabajo
    }

    if (!autenticado) {
      if (msg.tipo === 'terminal_autenticada') {
        if (msg.terminalId !== TERMINAL_ID) {
          console.error('[Auth] terminalId devuelto no coincide con el configurado -- cerrando (fail closed)');
          ws.close();
          return;
        }
        autenticado = true;
        espera = 5; // reinicio de backoff SOLO tras autenticación exitosa
        console.log(`[Auth] Terminal autenticada terminal=${msg.terminalId} negocio=${msg.negocioId ?? '-'} sucursal=${msg.sucursalId ?? '-'}`);
        return;
      }
      if (msg.tipo === 'error') {
        console.error('[Auth] Autenticación fallida -- cerrando conexión, sin caer a legacy');
        ws.close();
        return;
      }
      // Cualquier otro mensaje antes de autenticar: se ignora por completo.
      // No se imprime, no se confirma nada, no se almacena ningún trabajo.
      return;
    }

    // Ya autenticado: solo se procesan trabajos de impresión. Ningún
    // mensaje administrativo (confirmaciones, etc.) dispara impresión.
    if (msg.tipo !== 'nuevo_pedido') return;
    procesarTrabajo(msg).catch((e) => console.error('[Job] Error inesperado procesando trabajo:', e.message));
  });

  ws.on('close', (code) => {
    autenticado = false;
    const jitterMs = Math.floor(Math.random() * 500);
    console.warn(`[WS] Desconectado (${code}). Reintento en ~${espera}s...`);
    setTimeout(conectar, espera * 1000 + jitterMs);
    espera = Math.min(espera * 2, 60);
  });

  ws.on('error', (e) => {
    console.error('[WS] Error:', e.message);
  });
}

// ─── Arranque ─────────────────────────────────────────────────────────────────
export function main() {
  const cfg = resolverConfig();
  const errores = validarConfig(cfg);
  if (errores.length > 0) {
    console.error('[Config] No se puede iniciar -- configuración incompleta:');
    for (const e of errores) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  TERMINAL_ID    = cfg.terminalId;
  TERMINAL_TOKEN = cfg.terminalToken;
  PRINTER_NAME   = cfg.printerName;
  ANCHO_PAPEL    = cfg.anchoPapel;
  WS_URL         = construirUrlAutenticada(cfg.wsUrlRaw);

  conectar();
}

// Solo arranca automáticamente cuando este archivo es el entrypoint directo
// (`node print-agent.js`), nunca al importarlo desde una prueba.
const esEntrypoint = process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (esEntrypoint) {
  main();
}
