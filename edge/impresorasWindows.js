// Enumeración de las impresoras instaladas en Windows.
//
// Esta es la pieza que le quita al restaurante la pregunta imposible: nadie
// tiene que saber si la térmica quedó en COM4, en USB002 o en un puerto
// Bluetooth virtual que Windows bautizó distinto el martes. Si Windows la
// tiene instalada, aquí aparece con el nombre que el dueño ya reconoce.
//
// ─── LO QUE ENTRA Y LO QUE SALE ─────────────────────────────────────────────
//
// Entra: nada. Esta operación no recibe parámetros de la nube. Es una
// capacidad cerrada del agente, no un intérprete de comandos: Cloud pide
// "lista tus impresoras" y no puede influir en cómo se hace.
//
// Sale: solo { nombre, predeterminada, estado }. NO se devuelve el puerto, ni
// el driver, ni la ruta del servidor de impresión, ni el nombre de la PC, ni
// los GUID de cola. Nada de eso le sirve al restaurante y todo eso es
// superficie que no hace falta mandar a la nube.
//
// ─── SOBRE `estado` ─────────────────────────────────────────────────────────
//
// Windows expone un estado por impresora, pero para una térmica USB suele
// decir "Normal" incluso apagada: el spooler no la sondea hasta que hay
// trabajo. Así que aquí el estado es INFORMATIVO y nada más. Cuando no se
// puede afirmar con confianza, vale `desconocido`. Preferimos decir "no sé"
// antes que pintar "Conectada" en el panel y que el cocinero se quede
// esperando un papel que nunca sale.
import { spawn } from 'node:child_process';

const TIMEOUT_MS = 8000;

// Get-Printer (Windows 8/Server 2012 en adelante) y, si no existe, el viejo
// WMI Win32_Printer. Los dos scripts son constantes de este archivo: no se
// componen con nada externo.
const SCRIPT_GET_PRINTER = [
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  $ps = Get-Printer | Select-Object Name, PrinterStatus, Default',
  '} catch {',
  '  $ps = Get-WmiObject -Class Win32_Printer | Select-Object Name, PrinterStatus, Default',
  '}',
  '$ps | ForEach-Object {',
  '  [PSCustomObject]@{',
  '    nombre = $_.Name',
  '    estado = "$($_.PrinterStatus)"',
  '    predeterminada = [bool]$_.Default',
  '  }',
  '} | ConvertTo-Json -Compress',
].join('\r\n');

// Los estados de Windows que sí significan algo accionable. El resto se
// colapsa a 'desconocido' a propósito -- ver la nota de arriba.
const ESTADOS = {
  '0': 'desconocido', 'Normal': 'desconocido', '3': 'desconocido',
  '1': 'otro', '2': 'desconocido',
  '4': 'imprimiendo', 'Printing': 'imprimiendo',
  '5': 'calentando', '6': 'deteniendo',
  '7': 'detenida', 'Stopped': 'detenida', 'Paused': 'pausada',
  'Offline': 'sin_conexion', 'Error': 'error',
  'PaperOut': 'sin_papel', 'PaperJam': 'atasco',
  'Sin conexión': 'sin_conexion',
};

export function normalizarEstado(crudo) {
  if (crudo == null) return 'desconocido';
  return ESTADOS[String(crudo).trim()] || 'desconocido';
}

/**
 * Deja la lista en la forma mínima que el panel necesita. Se aplica SIEMPRE,
 * también en las pruebas: si un día Windows empieza a devolver un campo
 * nuevo, no se cuela solo hasta la nube.
 */
export function sanitizarImpresoras(crudas) {
  if (!Array.isArray(crudas)) return [];
  const vistas = new Set();
  const limpias = [];
  for (const p of crudas) {
    const nombre = typeof p?.nombre === 'string' ? p.nombre.trim() : '';
    if (!nombre || nombre.length > 200) continue;
    if (vistas.has(nombre)) continue;      // Windows a veces duplica colas
    vistas.add(nombre);
    limpias.push({
      nombre,
      predeterminada: p?.predeterminada === true,
      estado: normalizarEstado(p?.estado),
    });
    if (limpias.length >= 50) break;       // un mostrador no tiene 50 impresoras
  }
  return limpias;
}

function ejecutarPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let salida = '';
    let terminado = false;
    const fin = (r) => { if (!terminado) { terminado = true; resolve(r); } };

    const t = setTimeout(() => { try { proc.kill(); } catch {} fin({ ok: false, error: 'timeout' }); }, timeoutMs);
    t.unref?.();

    proc.stdout.on('data', (d) => { salida += d.toString(); });
    proc.stderr.on('data', (d) => { salida += d.toString(); });
    proc.on('error', (e) => { clearTimeout(t); fin({ ok: false, error: e.message }); });
    proc.on('close', () => { clearTimeout(t); fin({ ok: true, salida }); });

    try { proc.stdin.write(script); proc.stdin.end(); }
    catch (e) { clearTimeout(t); fin({ ok: false, error: e.message }); }
  });
}

/**
 * Devuelve { ok, impresoras, error }.
 *
 * Nunca lanza: si Windows no coopera, el Edge tiene que seguir imprimiendo lo
 * que ya tiene configurado. Una enumeración fallida es un problema de
 * configuración, no de operación.
 */
export async function listarImpresorasWindows({ ejecutor = ejecutarPowerShell, timeoutMs = TIMEOUT_MS, logger = null } = {}) {
  if (process.platform !== 'win32' && !process.env.XABOR_FORZAR_ENUMERACION) {
    return { ok: false, impresoras: [], error: 'este equipo no es Windows' };
  }
  try {
    const r = await ejecutor(SCRIPT_GET_PRINTER, timeoutMs);
    if (!r.ok) return { ok: false, impresoras: [], error: r.error || 'no se pudo consultar Windows' };

    let datos;
    try {
      datos = JSON.parse(String(r.salida).trim() || '[]');
    } catch {
      return { ok: false, impresoras: [], error: 'Windows devolvió una respuesta que no se pudo leer' };
    }
    // ConvertTo-Json colapsa un único elemento a objeto, no a array.
    const lista = Array.isArray(datos) ? datos : [datos];
    return { ok: true, impresoras: sanitizarImpresoras(lista), error: null };
  } catch (e) {
    logger?.warn('impresoras.enumeracion.error', { error: e.message });
    return { ok: false, impresoras: [], error: e.message };
  }
}
