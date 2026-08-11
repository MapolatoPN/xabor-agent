// Transporte "windows_spooler": entrega los bytes ESC/POS a una impresora YA
// instalada en Windows, usando la API de impresión del sistema.
//
// ─── POR QUÉ EL SPOOLER Y NO USB/BLUETOOTH DIRECTO ──────────────────────────
//
// Xabor no habla USB ni Bluetooth, y no va a hacerlo. Windows ya resolvió ese
// problema: si el restaurante consiguió instalar su térmica —por cable, por
// Bluetooth emparejado, por lo que sea— entonces existe en el spooler con un
// nombre humano, y ese nombre es todo lo que necesitamos. Eso convierte
// "¿en qué puerto quedó hoy la impresora?" en una pregunta que nadie tiene
// que hacerse.
//
// ─── POR QUÉ RAW Y NO Out-Printer ───────────────────────────────────────────
//
// El agente legado caía a `Out-Printer` cuando la ruta RAW fallaba. Aquí no.
// `Out-Printer` manda TEXTO por el driver: reinterpreta el contenido, aplica
// fuente y márgenes, y se come los bytes de control. Con ESC/POS eso no es un
// respaldo degradado, es basura impresa: el ESC @ o el comando de corte salen
// como caracteres. Un fallo explícito es mejor que tres metros de papel con
// símbolos raros.
//
// ─── QUÉ SE PUEDE SABER DE VERDAD ───────────────────────────────────────────
//
// Con el spooler se sabe MÁS que con RAW TCP, pero sigue sin saberse lo único
// que le importa al cocinero:
//
//   A) la impresora existe en el spooler        → observable (OpenPrinter)
//   B) el spooler aceptó el documento           → observable (StartDocPrinter)
//   C) el spooler recibió los bytes             → observable (WritePrinter)
//   D) la impresora los procesó                 → NO observable
//   E) salió papel                              → NO observable
//
// Por eso `enviado` significa exactamente "Windows aceptó los bytes", nunca
// "se imprimió". El papel puede seguir sin salir porque la impresora está
// apagada, sin rollo o con la tapa abierta, y el spooler encolará feliz.
//
// ─── LOS TRES RESULTADOS ────────────────────────────────────────────────────
//
//   fallido    se sabe que NO salió ningún byte hacia el spooler. Falló al
//              abrir la impresora o al iniciar el documento. Reintentar es
//              seguro.
//   incierto   la escritura ya había empezado cuando algo se torció. Puede
//              haber papel o no. No se reintenta solo.
//   enviado    OpenPrinter → StartDoc → Write → EndDoc → Close, todo bien.
//
// La frontera entre `fallido` e `incierto` es el primer WritePrinter. El
// script anuncia `ESCRIBIENDO` por stdout justo ANTES de esa llamada, y este
// módulo llama a `alEscribir()` en cuanto lo lee: a partir de ese instante el
// trabajo deja de ser reintentable sin que lo decida una persona.
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TIMEOUT_POR_DEFECTO_MS = 20000;

// Errores Win32 que se ven de verdad en un mostrador, traducidos a algo que
// alguien pueda accionar sin buscar el código en internet.
const EXPLICACION_WIN32 = {
  2:    'Windows no encuentra esa impresora: revisa que siga instalada y con ese mismo nombre',
  5:    'Windows negó el acceso a la impresora: el agente no tiene permisos sobre ella',
  1801: 'el nombre de impresora no es válido para Windows',
  1722: 'el servicio de cola de impresión (Print Spooler) no está corriendo',
  6:    'el identificador de la impresora dejó de ser válido a mitad del trabajo',
};

function explicarWin32(codigo) {
  return EXPLICACION_WIN32[Number(codigo)] || `Windows devolvió el error ${codigo}`;
}

// El nombre de impresora es el ÚNICO dato que entra al script, y entra como
// literal de cadena PowerShell entre comillas simples. Ahí dentro solo la
// propia comilla simple tiene significado, y se escapa duplicándola. No se
// concatena nada más: el resto del script es constante de este archivo.
export function escaparNombrePs(nombre) {
  return String(nombre).replace(/'/g, "''");
}

// La firma P/Invoke, en UNA sola linea. C# no necesita saltos de linea y el
// literal va entre comillas SIMPLES de PowerShell, asi que las dobles de
// DllImport("winspool.drv") viajan sin escapar.
const FIRMA_WIN32 = 'using System; using System.Runtime.InteropServices; public class XaborRawPrint { '
  + '[DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true)] public static extern bool OpenPrinter(string pName, out IntPtr phPrinter, IntPtr pDefault); '
  + '[DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true)] public static extern int StartDocPrinter(IntPtr hPrinter, int Level, ref DOCINFO di); '
  + '[DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter); '
  + '[DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten); '
  + '[DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter); '
  + '[DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter); '
  + '[DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter); '
  + '[StructLayout(LayoutKind.Sequential)] public struct DOCINFO { '
  + '[MarshalAs(UnmanagedType.LPStr)] public string pDocName; '
  + '[MarshalAs(UnmanagedType.LPStr)] public string pOutputFile; '
  + '[MarshalAs(UnmanagedType.LPStr)] public string pDataType; } }';

/**
 * El script es fijo y va en UNA sola sentencia por linea, unidas por `;`.
 *
 * La primera version era un bloque con `$ErrorActionPreference = "Stop"` y
 * try/catch/finally multilinea. Alimentado por stdin (`powershell -Command -`),
 * PowerShell procesa la entrada como si se tecleara en consola y ese bloque
 * puede terminar con codigo 0 y stdout VACIO: ni OK ni ERROR, silencio. Es
 * exactamente el mismo fallo que ya habia roto la enumeracion de impresoras, y
 * aqui costo un GATE 5 entero -- el trabajo llegaba con su destino correcto y
 * el transporte no sabia decir que habia pasado.
 *
 * Ahora cada etapa cierra sus handles y emite su propia linea antes de salir:
 * el script SIEMPRE dice algo reconocible. Verificado contra una impresora
 * inexistente en Windows real: `ERROR:OPEN:1801`, exit 1, sin silencio.
 *
 * Cloud no lo envia, no lo compone y no puede influir en el: lo unico variable
 * son el nombre de la impresora y la ruta del temporal que este mismo proceso
 * acaba de escribir, y los dos entran como literales escapados.
 */
export function construirScript(nombreImpresora, rutaBytes) {
  const prn = escaparNombrePs(nombreImpresora);
  const src = escaparNombrePs(rutaBytes);
  return [
    `Add-Type -TypeDefinition '${FIRMA_WIN32}'`,
    `$prn = '${prn}'`,
    `$src = '${src}'`,
    '$bytes = [System.IO.File]::ReadAllBytes($src)',
    '$ph = [IntPtr]::Zero',
    // Etapa 1: abrir la cola. Si falla, no salio ni un byte -> `fallido`.
    'if (-not [XaborRawPrint]::OpenPrinter($prn, [ref]$ph, [IntPtr]::Zero)) { Write-Output ("ERROR:OPEN:" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1 }',
    '$di = New-Object XaborRawPrint+DOCINFO',
    "$di.pDocName = 'Xabor'",
    // RAW: el spooler pasa los bytes tal cual, sin que ningun driver los
    // reinterprete. Es lo que hace que el ESC/POS llegue intacto.
    "$di.pDataType = 'RAW'",
    '$job = [XaborRawPrint]::StartDocPrinter($ph, 1, [ref]$di)',
    // Etapa 2: si el spooler no acepta el documento, se cierra la cola y se
    // sale. Tampoco salio nada -> `fallido`.
    'if ($job -le 0) { $e = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error(); [XaborRawPrint]::ClosePrinter($ph) | Out-Null; Write-Output ("ERROR:STARTDOC:" + $e); exit 1 }',
    '[XaborRawPrint]::StartPagePrinter($ph) | Out-Null',
    // Frontera: a partir de la linea siguiente ya no se puede afirmar que no
    // salio nada. Se anuncia ANTES de escribir, no despues.
    "Write-Output 'ESCRIBIENDO'",
    '$escritos = 0',
    '$ok = [XaborRawPrint]::WritePrinter($ph, $bytes, $bytes.Length, [ref]$escritos)',
    '$err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()',
    // Los handles se cierran SIEMPRE, tambien cuando la escritura fallo: un
    // handle filtrado deja el trabajo colgado en la cola de Windows y bloquea
    // el siguiente.
    '[XaborRawPrint]::EndPagePrinter($ph) | Out-Null',
    '[XaborRawPrint]::EndDocPrinter($ph) | Out-Null',
    '[XaborRawPrint]::ClosePrinter($ph) | Out-Null',
    'if (-not $ok) { Write-Output ("ERROR:WRITE:" + $err); exit 1 }',
    'if ($escritos -ne $bytes.Length) { Write-Output ("ERROR:PARCIAL:" + $escritos + " de " + $bytes.Length); exit 1 }',
    'Write-Output ("OK:" + $escritos)',
  ].join('; ');
}

/**
 * Interpreta la salida del script. Separado a propósito: es la lógica que
 * decide entre `fallido` e `incierto`, y se puede probar sin Windows.
 *
 * `empezoAEscribir` viene de haber visto la marca ESCRIBIENDO, no de
 * suponerlo por el código de salida.
 */
export function interpretarSalida({ salida = '', codigoSalida = 0, empezoAEscribir = false, error = null }) {
  const texto = String(salida);

  if (error) {
    // El proceso ni siquiera arrancó (no hay PowerShell, no hay permisos).
    return { resultado: 'fallido', codigo: 'SPOOLER_NO_EJECUTABLE',
             detalle: `no se pudo ejecutar la impresión en Windows: ${error}` };
  }

  const fallo = texto.match(/ERROR:([A-Z]+):?(.*)/);
  if (fallo) {
    const [, etapa, resto] = fallo;
    const win32 = (resto || '').trim();
    if (etapa === 'OPEN') {
      return { resultado: 'fallido', codigo: 'IMPRESORA_NO_DISPONIBLE',
               detalle: explicarWin32(win32) };
    }
    if (etapa === 'STARTDOC') {
      return { resultado: 'fallido', codigo: 'SPOOLER_RECHAZO_DOCUMENTO',
               detalle: `el spooler no aceptó el documento: ${explicarWin32(win32)}` };
    }
    if (etapa === 'WRITE' || etapa === 'PARCIAL') {
      // Ya se había anunciado ESCRIBIENDO: pudo salir parte del ticket.
      return { resultado: 'incierto', codigo: `SPOOLER_${etapa}`,
               detalle: etapa === 'PARCIAL'
                 ? `el spooler solo aceptó parte de los datos (${win32})`
                 : `la escritura falló a medias: ${explicarWin32(win32)}` };
    }
    // Excepción: depende de si ya se había cruzado la frontera.
    return empezoAEscribir
      ? { resultado: 'incierto', codigo: 'SPOOLER_EXCEPCION', detalle: win32 || 'error inesperado en Windows' }
      : { resultado: 'fallido', codigo: 'SPOOLER_EXCEPCION', detalle: win32 || 'error inesperado en Windows' };
  }

  const ok = texto.match(/OK:(\d+)/);
  if (ok && codigoSalida === 0) {
    return { resultado: 'enviado', codigo: null,
             detalle: `Windows aceptó ${ok[1]} bytes (no confirma que haya salido papel)` };
  }

  // Sin marca de éxito ni de error reconocible. Si ya se estaba escribiendo,
  // no se puede afirmar que no salió nada.
  return empezoAEscribir
    ? { resultado: 'incierto', codigo: 'SPOOLER_SIN_RESPUESTA',
        detalle: 'la impresión empezó pero Windows no confirmó cómo terminó' }
    : { resultado: 'fallido', codigo: 'SPOOLER_SIN_RESPUESTA',
        detalle: 'Windows no devolvió resultado de la impresión' };
}

/**
 * Ejecutor por defecto: PowerShell no interactivo, sin perfil, con la
 * política de ejecución sorteada SOLO para este proceso (-ExecutionPolicy
 * Bypass afecta a la invocación, no deja nada cambiado en la máquina).
 *
 * El script llega por stdin: así no queda un .ps1 en disco que alguien pueda
 * sustituir entre que se escribe y se ejecuta.
 */
function ejecutorPowerShell({ script, timeoutMs, alVerMarca }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { windowsHide: true });
    } catch (e) {
      return resolve({ salida: '', codigoSalida: -1, error: e.message });
    }

    let salida = '';
    let terminado = false;
    const finalizar = (r) => { if (!terminado) { terminado = true; resolve(r); } };

    const temporizador = setTimeout(() => {
      // Matar el proceso NO deshace lo que el spooler ya recibió: por eso el
      // resultado lo decide `interpretarSalida` según se haya cruzado o no la
      // frontera de escritura.
      try { proc.kill(); } catch {}
      finalizar({ salida, codigoSalida: -1, expiro: true });
    }, timeoutMs);
    temporizador.unref?.();

    proc.stdout.on('data', (d) => {
      salida += d.toString();
      if (salida.includes('ESCRIBIENDO')) alVerMarca?.();
    });
    proc.stderr.on('data', (d) => { salida += d.toString(); });

    proc.on('error', (e) => { clearTimeout(temporizador); finalizar({ salida, codigoSalida: -1, error: e.message }); });
    proc.on('close', (codigo) => { clearTimeout(temporizador); finalizar({ salida, codigoSalida: codigo }); });

    try {
      proc.stdin.write(script);
      proc.stdin.end();
    } catch (e) {
      clearTimeout(temporizador);
      finalizar({ salida, codigoSalida: -1, error: e.message });
    }
  });
}

/**
 * `ejecutor` se inyecta para poder probar las tres ramas sin Windows. En
 * producción es siempre el de arriba -- y que sea inyectable no abre ninguna
 * puerta: no viene de la nube ni de la configuración, solo del código.
 */
export function crearTransporteWindowsSpooler({ logger, timeoutMs = TIMEOUT_POR_DEFECTO_MS, ejecutor = ejecutorPowerShell } = {}) {
  return {
    nombre: 'windows_spooler',

    async enviar(config, bytes, contexto = {}) {
      const nombreImpresora = config?.config?.spoolerNombre || config?.config?.nombreWindows || null;

      // Sin nombre NO se imprime. Jamás se cae a la impresora predeterminada
      // de Windows: en un local con caja y cocina, "la default" es la forma
      // más rápida de mandar la comanda al ticket del cliente.
      if (typeof nombreImpresora !== 'string' || !nombreImpresora.trim()) {
        return { resultado: 'fallido', codigo: 'SIN_IMPRESORA_ASIGNADA',
                 detalle: 'esta impresora no tiene asignado un equipo de Windows' };
      }
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return { resultado: 'fallido', codigo: 'SIN_CONTENIDO', detalle: 'no había nada que imprimir' };
      }

      // Nombre generado aquí, nunca derivado de datos del trabajo: ni el
      // documento ni el negocio pueden influir en la ruta.
      const rutaBytes = path.join(tmpdir(), `xabor-${crypto.randomUUID()}.bin`);
      let empezoAEscribir = false;

      try {
        await writeFile(rutaBytes, bytes);
      } catch (e) {
        return { resultado: 'fallido', codigo: 'SIN_ARCHIVO_TEMPORAL',
                 detalle: `no se pudo preparar la impresión: ${e.message}` };
      }

      try {
        const r = await ejecutor({
          script: construirScript(nombreImpresora, rutaBytes),
          timeoutMs,
          alVerMarca: () => {
            if (empezoAEscribir) return;
            empezoAEscribir = true;
            // Antes de resolver: el worker necesita saber que a partir de
            // aquí un reintento automático podría duplicar papel.
            try { contexto.alEscribir?.(); } catch (e) {
              logger?.warn('spooler.alEscribir.error', { error: e.message });
            }
          },
        });

        if (r.expiro) {
          return empezoAEscribir
            ? { resultado: 'incierto', codigo: 'SPOOLER_TIMEOUT',
                detalle: 'Windows tardó demasiado y la impresión ya había empezado' }
            : { resultado: 'fallido', codigo: 'SPOOLER_TIMEOUT',
                detalle: 'Windows no respondió a tiempo y no llegó a enviarse nada' };
        }
        return interpretarSalida({ ...r, empezoAEscribir });
      } catch (e) {
        // Nada de lo de arriba debe poder tumbar el proceso del Edge: si el
        // agente se cae, el restaurante deja de imprimir TODO.
        logger?.error('spooler.error', { error: e.message });
        return empezoAEscribir
          ? { resultado: 'incierto', codigo: 'SPOOLER_ERROR', detalle: e.message }
          : { resultado: 'fallido', codigo: 'SPOOLER_ERROR', detalle: e.message };
      } finally {
        // El .bin lleva el contenido del ticket: se borra siempre, también
        // cuando la impresión falló.
        await unlink(rutaBytes).catch(() => {});
      }
    },
  };
}
