# Sonda: ¿puede NT AUTHORITY\SYSTEM imprimir en la térmica de Xabor?
#
# Es el gate que decide bajo qué cuenta va a correr el servicio de Windows de
# Xabor Edge. Que el spooler funcione desde la sesión interactiva no demuestra
# nada sobre SYSTEM: las impresoras de tipo 'Connection' viven en el perfil del
# usuario (HKCU) y son invisibles fuera de su sesión. Las 'Local' están en
# HKLM y sí deberían verse. Esta sonda lo comprueba en vez de suponerlo.
#
# Usa la MISMA secuencia Win32 que usa el transporte windows_spooler del Edge
# -- OpenPrinter, StartDocPrinter, StartPagePrinter, WritePrinter,
# EndPagePrinter, EndDocPrinter, ClosePrinter -- y el mismo pDataType 'RAW'.
# Nunca Out-Printer: eso manda texto y el driver reinterpreta el ESC/POS.
#
# Imprime UNA hoja pequeña, claramente marcada. No toca ninguna otra impresora.
# No escribe credenciales ni secretos en ningún sitio.
#
# No se ejecuta a mano: la lanza una tarea programada corriendo como SYSTEM.
# Ver docs/gate-localsystem.md para los comandos exactos.

$ErrorActionPreference = 'Continue'

$IMPRESORA = 'POS Printer 203DPI  Series 2'   # OJO: DOS espacios antes de 'Series'
$RESULTADO = 'C:\xabor-print\probe-system-result.txt'

$lineas = New-Object System.Collections.Generic.List[string]
function Anotar([string]$t) { $lineas.Add($t) | Out-Null }

Anotar "XABOR - SONDA LOCAL SYSTEM"
Anotar ("FECHA=" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# ─── 1. ¿Quién soy de verdad? ───────────────────────────────────────────────
$quien = 'DESCONOCIDO'
try { $quien = [Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { }
Anotar ("USUARIO_EFECTIVO=" + $quien)
if ($quien -eq 'NT AUTHORITY\SYSTEM') { Anotar "IDENTIDAD=SYSTEM" }
else { Anotar "IDENTIDAD=NO_ES_SYSTEM"; Anotar "AVISO=la sonda no corrio como SYSTEM; el resultado NO vale para el gate" }

# ─── 2. ¿Ve la impresora? ───────────────────────────────────────────────────
$laVe = $false
try {
  $todas = Get-Printer -ErrorAction Stop
  Anotar ("IMPRESORAS_VISIBLES=" + $todas.Count)
  foreach ($p in $todas) { Anotar ("  - " + $p.Name + " [tipo=" + $p.Type + "]") }
  $laVe = [bool]($todas | Where-Object { $_.Name -eq $IMPRESORA })
  if ($laVe) { Anotar "GET_PRINTER=OK" } else { Anotar "GET_PRINTER=FALLO"; Anotar ("DETALLE=SYSTEM no ve '" + $IMPRESORA + "'") }
} catch {
  Anotar "GET_PRINTER=FALLO"
  Anotar ("DETALLE=" + $_.Exception.Message)
}

# ─── 3..6. La secuencia Win32 completa, en RAW ──────────────────────────────
if (-not $laVe) {
  Anotar "OPEN_PRINTER=OMITIDO"
  Anotar "START_DOC=OMITIDO"
  Anotar "WRITE=OMITIDO"
  Anotar "END_DOC=OMITIDO"
  Anotar "RESULTADO_GLOBAL=FALLO_EN_GET_PRINTER"
} else {
  $firma = 'using System; using System.Runtime.InteropServices; public class XaborRawPrint { ' +
    '[DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true)] public static extern bool OpenPrinter(string pName, out IntPtr phPrinter, IntPtr pDefault); ' +
    '[DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true)] public static extern int StartDocPrinter(IntPtr hPrinter, int Level, ref DOCINFO di); ' +
    '[DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter); ' +
    '[DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten); ' +
    '[DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter); ' +
    '[DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter); ' +
    '[DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter); ' +
    '[StructLayout(LayoutKind.Sequential)] public struct DOCINFO { ' +
    '[MarshalAs(UnmanagedType.LPStr)] public string pDocName; ' +
    '[MarshalAs(UnmanagedType.LPStr)] public string pOutputFile; ' +
    '[MarshalAs(UnmanagedType.LPStr)] public string pDataType; } }'

  $global = 'FALLO'
  try {
    Add-Type -TypeDefinition $firma -ErrorAction Stop

    # ESC/POS mínimo: inicializar, centrar, negrita, el texto, avance y corte.
    $b = New-Object System.Collections.Generic.List[byte]
    $b.AddRange([byte[]]@(0x1B,0x40))            # ESC @  inicializar
    $b.AddRange([byte[]]@(0x1B,0x61,0x01))       # centrado
    $b.AddRange([byte[]]@(0x1B,0x45,0x01))       # negrita
    $b.AddRange([System.Text.Encoding]::ASCII.GetBytes("XABOR`n"))
    $b.AddRange([byte[]]@(0x1B,0x45,0x00))       # fin negrita
    $b.AddRange([System.Text.Encoding]::ASCII.GetBytes("PRUEBA SERVICIO WINDOWS`n"))
    $b.AddRange([System.Text.Encoding]::ASCII.GetBytes("LOCAL SYSTEM`n"))
    $b.AddRange([System.Text.Encoding]::ASCII.GetBytes((Get-Date -Format 'dd/MM/yyyy HH:mm:ss') + "`n"))
    $b.AddRange([byte[]]@(0x0A,0x0A,0x0A,0x0A))  # avance para poder cortar
    $b.AddRange([byte[]]@(0x1D,0x56,0x42,0x00))  # GS V B 0  corte parcial
    $bytes = $b.ToArray()
    Anotar ("BYTES_A_ESCRIBIR=" + $bytes.Length)

    $ph = [IntPtr]::Zero
    if (-not [XaborRawPrint]::OpenPrinter($IMPRESORA, [ref]$ph, [IntPtr]::Zero)) {
      Anotar "OPEN_PRINTER=FALLO"
      Anotar ("WIN32_ERROR=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
      Anotar "START_DOC=OMITIDO"; Anotar "WRITE=OMITIDO"; Anotar "END_DOC=OMITIDO"
      $global = 'FALLO_EN_OPEN_PRINTER'
    } else {
      Anotar "OPEN_PRINTER=OK"
      $di = New-Object XaborRawPrint+DOCINFO
      $di.pDocName = 'Xabor sonda LocalSystem'
      $di.pOutputFile = $null
      $di.pDataType = 'RAW'

      if ([XaborRawPrint]::StartDocPrinter($ph, 1, [ref]$di) -eq 0) {
        Anotar "START_DOC=FALLO"
        Anotar ("WIN32_ERROR=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
        Anotar "WRITE=OMITIDO"; Anotar "END_DOC=OMITIDO"
        [XaborRawPrint]::ClosePrinter($ph) | Out-Null
        $global = 'FALLO_EN_START_DOC'
      } else {
        Anotar "START_DOC=OK"
        [XaborRawPrint]::StartPagePrinter($ph) | Out-Null

        # A partir de aquí puede haber salido papel: es la frontera.
        $escritos = 0
        $ok = [XaborRawPrint]::WritePrinter($ph, $bytes, $bytes.Length, [ref]$escritos)
        $errEscritura = [Runtime.InteropServices.Marshal]::GetLastWin32Error()

        [XaborRawPrint]::EndPagePrinter($ph) | Out-Null
        $finDoc = [XaborRawPrint]::EndDocPrinter($ph)
        [XaborRawPrint]::ClosePrinter($ph) | Out-Null

        if (-not $ok) {
          Anotar "WRITE=FALLO"; Anotar ("WIN32_ERROR=" + $errEscritura); Anotar "END_DOC=OMITIDO"
          $global = 'FALLO_EN_WRITE'
        } elseif ($escritos -ne $bytes.Length) {
          Anotar ("WRITE=PARCIAL escritos=" + $escritos + " de " + $bytes.Length)
          Anotar "END_DOC=OMITIDO"
          $global = 'ESCRITURA_PARCIAL'
        } else {
          Anotar ("WRITE=OK escritos=" + $escritos)
          if ($finDoc) { Anotar "END_DOC=OK"; $global = 'OK' }
          else { Anotar "END_DOC=FALLO"; Anotar ("WIN32_ERROR=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); $global = 'FALLO_EN_END_DOC' }
        }
      }
    }
  } catch {
    Anotar "EXCEPCION=SI"
    Anotar ("DETALLE=" + $_.Exception.Message)
    $global = 'EXCEPCION'
  }
  Anotar ("RESULTADO_GLOBAL=" + $global)
}

Anotar ""
Anotar "NOTA: 'WRITE=OK' significa que Windows acepto los bytes, NO que salio papel."
Anotar "      Que salga la hoja solo lo confirma una persona mirando la impresora."

# El archivo se escribe siempre, pase lo que pase: sin él la sonda no sirve.
try {
  New-Item -ItemType Directory -Force -Path (Split-Path $RESULTADO) -ErrorAction SilentlyContinue | Out-Null
  $lineas -join "`r`n" | Out-File -FilePath $RESULTADO -Encoding utf8 -Force
} catch {
  $lineas -join "`r`n" | Out-File -FilePath "$env:TEMP\xabor-probe-system-result.txt" -Encoding utf8 -Force
}
