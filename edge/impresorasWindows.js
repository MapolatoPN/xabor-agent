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

// Veinte segundos, y no ocho.
//
// El primer arranque de powershell.exe despues de un reboot paga el CLR y sus
// ensamblados desde disco frio, en un equipo que ademas esta terminando de
// arrancar. En la Surface de Acuna eso supero los 8 s y el listado murio con
// 'timeout' mientras la impresion RAW -- que no lanza PowerShell en frio ni
// toca WMI -- funcionaba sin problema segundos despues.
//
// Este numero tiene que ser MENOR que TIMEOUT_IMPRESORAS_MS de la nube: quien
// espera la respuesta no puede rendirse antes que quien la produce.
const TIMEOUT_MS = 20000;

// La impresora predeterminada se consulta aparte y con prisa. Es un dato
// decorativo -- Xabor nunca la usa como destino -- y venia arrastrando al
// listado entero: WMI se inicializa perezosamente y su PRIMERA consulta tras
// un boot es la mas lenta de la vida del equipo.
const TIMEOUT_DEFAULT_MS = 4000;

// El script va en UNA sola línea, a propósito.
//
// La primera versión era un bloque multilínea con `$ErrorActionPreference =
// "Stop"` y un try/catch. Alimentado por stdin (`powershell -Command -`),
// PowerShell procesa la entrada como si se tecleara en la consola, y ese
// bloque terminaba saliendo con código 0 y **stdout vacío**: ni datos ni
// error. Desde fuera parecía "este equipo no tiene impresoras". Lo destapó
// el primer discovery real contra una Surface con seis impresoras instaladas.
//
// `Get-Printer` existe desde Windows 8 / Server 2012 y es el camino bueno:
// devuelve el estado como texto ('Normal', 'Offline'…). Lo único que no trae
// es cuál es la predeterminada, así que ese dato se saca de WMI y se compara
// por nombre. Si `Get-Printer` no existiera, el pipeline no emite nada y la
// consulta se reporta como fallida -- que es la verdad, no una lista vacía.
//
// Constante de este archivo: no se compone con nada que venga de la nube.
// Lo critico: la lista. Sin WMI, sin nada que pueda tardar.
const SCRIPT_GET_PRINTER =
  'Get-Printer | ForEach-Object { [PSCustomObject]@{ nombre = $_.Name; estado = "$($_.PrinterStatus)"; predeterminada = $false } } | ConvertTo-Json -Compress';

// Y lo opcional, en su propia consulta. Si tarda o falla, la lista sale igual
// y ninguna impresora queda marcada como predeterminada. Que el panel no sepa
// cual es la default es un detalle; que no muestre ninguna impresora deja al
// restaurante sin poder configurar nada.
const SCRIPT_DEFAULT =
  '(Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1).Name';

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

    const crudo = String(r.salida ?? '').trim();

    // Sin salida NO es "cero impresoras": es una consulta que no se pudo
    // hacer. Antes esto se convertía en `JSON.parse('' || '[]')` -> lista
    // vacía con ok:true, y el panel decía tranquilamente que el equipo no
    // tenía impresoras mientras Windows tenía seis. Un fallo disfrazado de
    // éxito es peor que un fallo: nadie lo va a investigar.
    //
    // Una lista realmente vacía sí existe -- un equipo sin impresoras
    // instaladas -- pero entonces PowerShell devuelve `[]` explícito, y ese
    // caso sí pasa por aquí como ok:true.
    if (!crudo) {
      return { ok: false, impresoras: [],
               error: 'Windows no devolvió la lista de impresoras (respuesta vacía)' };
    }

    let datos;
    try {
      datos = JSON.parse(crudo);
    } catch {
      return { ok: false, impresoras: [], error: 'Windows devolvió una respuesta que no se pudo leer' };
    }
    // ConvertTo-Json colapsa un único elemento a objeto, no a array.
    const lista = Array.isArray(datos) ? datos : [datos];
    const impresoras = sanitizarImpresoras(lista);

    // La predeterminada, en una segunda consulta que NO puede tumbar nada.
    // Cualquier fallo aquí se traga: la lista ya está y es lo que importa.
    try {
      const d = await ejecutor(SCRIPT_DEFAULT, TIMEOUT_DEFAULT_MS);
      const nombre = d?.ok ? String(d.salida ?? '').trim() : '';
      if (nombre) {
        for (const i of impresoras) if (i.nombre === nombre) i.predeterminada = true;
      } else if (d && !d.ok) {
        logger?.warn?.('impresoras.default.no_resuelta', { motivo: d.error || 'sin salida' });
      }
    } catch (e) {
      logger?.warn?.('impresoras.default.no_resuelta', { motivo: e.message });
    }

    return { ok: true, impresoras, error: null };
  } catch (e) {
    logger?.warn('impresoras.enumeracion.error', { error: e.message });
    return { ok: false, impresoras: [], error: e.message };
  }
}
