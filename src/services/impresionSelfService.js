/**
 * impresionSelfService.js — Config → Impresoras, en el idioma del restaurante.
 *
 * Esta capa existe para traducir. El modelo de abajo (terminales, impresoras,
 * rutas, transportes, ancho en columnas) está bien y no se toca; lo que hace
 * falta es que el dueño de Carnitas no tenga que aprenderlo. Aquí, un
 * restaurante solo dice tres cosas:
 *
 *     esta impresora  →  es la de Cocina  →  usa papel de 58 mm
 *
 * y de este lado se convierte en: una fila en `impresoras` con transporte
 * `windows_spooler` y el nombre de Windows en `config`, más una fila en
 * `impresion_rutas` con ambito='documento'.
 *
 * No se inventa nomenclatura nueva: 'comanda' y 'cuenta' son las claves que
 * `impresion_rutas` ya usaba desde la 043.
 */
import { pool } from './database.js';
import {
  listarImpresoras, crearImpresora, actualizarImpresora,
  listarRutas, crearRuta, eliminarRuta, resolverSucursal,
} from './impresionService.js';
import { listarEdges } from './edgeService.js';

/**
 * Ancho: el cliente elige milímetros porque es lo que dice la caja del rollo.
 * El renderer necesita columnas.
 *
 *   58 mm → 32 columnas. Una térmica de 58 mm imprime 384 puntos de ancho y
 *           la fuente A ocupa 12 puntos por carácter: 384/12 = 32 exactas.
 *   80 mm → 42 columnas. 576 puntos daría 48, pero 42 es lo que ya usaba
 *           Xabor en producción y lo que la mayoría de los modelos de 80 mm
 *           acepta sin recortar por márgenes del cabezal. Cambiarlo ahora
 *           movería todos los tickets ya impresos sin ninguna necesidad.
 */
export const ANCHOS_MM = { 58: 32, 80: 42 };

export function columnasParaMm(mm) {
  return ANCHOS_MM[Number(mm)] || null;
}

export function mmParaColumnas(columnas) {
  const n = Number(columnas);
  // Se elige el mm cuyo ancho canónico esté más cerca: una impresora
  // configurada a mano con 33 columnas se muestra como 58 mm, que es lo que
  // el dueño entiende, en vez de dejar el campo vacío.
  if (!Number.isFinite(n)) return 80;
  return n <= 36 ? 58 : 80;
}

/**
 * Destinos que el panel ofrece. La clave de la izquierda es la que ve el
 * restaurante; la de la derecha es la que `impresion_rutas` ya tenía.
 */
export const DESTINOS = {
  cocina: { clave: 'comanda',     etiqueta: 'Cocina' },
  caja:   { clave: 'cuenta',      etiqueta: 'Caja / Ticket' },
  cancelaciones: { clave: 'cancelacion', etiqueta: 'Cancelaciones' },
};

export function destinoDesdeClave(clave) {
  return Object.keys(DESTINOS).find((d) => DESTINOS[d].clave === clave) || null;
}

const NOMBRE_MAX = 200;

/**
 * Estado completo de Config → Impresoras para UN negocio.
 *
 * Devuelve, en una sola llamada: si hay equipo conectado, qué impresoras ve
 * ese equipo ahora mismo en Windows, y qué tiene ya configurado el negocio.
 * Un solo viaje porque el panel necesita las tres cosas a la vez para poder
 * decir "esta impresora está configurada pero ahora no aparece".
 *
 * `pedirImpresoras` se inyecta (lo implementa server.js, que es quien tiene
 * los WebSockets): este módulo no sabe de sockets.
 */
export async function estadoImpresorasNegocio(negocioId, { pedirImpresoras } = {}) {
  // Se reutiliza listarEdges: ya filtra por negocio a través de sucursales y
  // es la misma lista que ve el resto del sistema. No se duplica la consulta.
  const terminales = await listarEdges(negocioId);

  const configuradas = (await listarImpresoras(negocioId)).filter((i) => i.transporte === 'windows_spooler');
  const rutas = await listarRutas(negocioId);

  const equipos = [];
  for (const t of terminales) {
    // La consulta se hace por terminal: las impresoras de un equipo son las
    // de ESE equipo, nunca una lista global del negocio.
    const consulta = pedirImpresoras
      ? await pedirImpresoras(t.id)
      : { ok: false, conectado: false, impresoras: [], error: 'sin canal con el equipo' };

    const detectadas = consulta.impresoras || [];
    const nombresDetectados = new Set(detectadas.map((i) => i.nombre));

    // Lo que el negocio ya configuró en este equipo, con su destino y ancho.
    const asignadas = configuradas
      .filter((i) => i.terminal_id === t.id)
      .map((i) => {
        const nombreWindows = i.config?.spoolerNombre || null;
        const destinos = rutas
          .filter((r) => r.impresora_id === i.id && r.ambito === 'documento' && r.activa)
          .map((r) => destinoDesdeClave(r.clave))
          .filter(Boolean);
        return {
          id: i.id,
          nombreWindows,
          destinos,
          anchoMm: mmParaColumnas(i.ancho_columnas),
          activa: i.activa,
          // Configurada pero ausente de la lista actual: puede estar apagada
          // o desconectada. NO se borra nada -- ver la nota del endpoint.
          presente: consulta.ok ? nombresDetectados.has(nombreWindows) : null,
        };
      });

    equipos.push({
      id: t.id,
      nombre: t.nombre,
      conectado: consulta.conectado === true,
      ultimaConexion: t.ultima_conexion,
      consultaOk: consulta.ok === true,
      errorConsulta: consulta.ok ? null : (consulta.error || null),
      // Las que Windows ve y todavía no tienen función asignada.
      detectadas: detectadas.map((d) => ({
        ...d,
        yaConfigurada: asignadas.some((a) => a.nombreWindows === d.nombre),
      })),
      asignadas,
    });
  }

  return { hayEquipo: equipos.length > 0, equipos, destinos: DESTINOS, anchos: Object.keys(ANCHOS_MM).map(Number) };
}

/**
 * Asigna (o reasigna) una impresora de Windows a una función.
 *
 * Idempotente por (terminal, nombre de Windows): volver a asignar la misma
 * impresora actualiza su fila en vez de crear una segunda. Sin esto, dos
 * clics seguidos en el panel dejarían dos impresoras iguales y la comanda
 * saldría por duplicado.
 */
export async function asignarImpresora(negocioId, { terminalId, nombreWindows, destino, anchoMm, sucursalId = null }) {
  if (typeof nombreWindows !== 'string' || !nombreWindows.trim() || nombreWindows.length > NOMBRE_MAX) {
    return { ok: false, error: 'Falta el nombre de la impresora' };
  }
  if (!DESTINOS[destino]) {
    return { ok: false, error: 'Elige para qué se va a usar esta impresora' };
  }
  const columnas = columnasParaMm(anchoMm);
  if (!columnas) return { ok: false, error: 'El ancho de papel tiene que ser 58 mm u 80 mm' };

  // El terminal DEBE pertenecer a este negocio. Esta es la comprobación que
  // impide que un terminal_id llegado del navegador salte de empresa.
  const { rows: [terminal] } = await pool.query(
    `SELECT t.id, t.sucursal_id FROM terminales t
       JOIN sucursales s ON s.id = t.sucursal_id
      WHERE t.id = $1 AND s.negocio_id = $2`,
    [terminalId, negocioId]);
  if (!terminal) return { ok: false, error: 'Ese equipo de impresión no es de este negocio' };

  const sucursal = await resolverSucursal(negocioId, sucursalId || terminal.sucursal_id);
  const nombre = nombreWindows.trim();

  const existentes = await listarImpresoras(negocioId);
  const yaExiste = existentes.find(
    (i) => i.terminal_id === terminalId && i.transporte === 'windows_spooler' && i.config?.spoolerNombre === nombre);

  let impresora;
  if (yaExiste) {
    impresora = await actualizarImpresora(negocioId, yaExiste.id, {
      anchoColumnas: columnas, activa: true,
      config: { ...(yaExiste.config || {}), spoolerNombre: nombre },
    });
  } else {
    impresora = await crearImpresora(negocioId, {
      terminalId,
      // El nombre visible ES el de Windows: el dueño reconoce "OFICHIDO
      // OS518", no "Impresora 1".
      nombre: nombre.slice(0, 80),
      transporte: 'windows_spooler',
      anchoColumnas: columnas,
      config: { spoolerNombre: nombre },
    });
  }

  // Ruta por documento. Se limpia primero lo que hubiera para no acumular
  // destinos: si el dueño cambia Cocina→Caja, la comanda no debe seguir
  // saliendo por las dos.
  const rutasActuales = await listarRutas(negocioId);
  for (const r of rutasActuales) {
    if (r.impresora_id === impresora.id && r.ambito === 'documento') {
      await eliminarRuta(negocioId, r.id).catch(() => {});
    }
  }
  await crearRuta(negocioId, {
    impresoraId: impresora.id, ambito: 'documento', clave: DESTINOS[destino].clave, modo: 'agregar',
  });

  return { ok: true, impresoraId: impresora.id, destino, anchoMm: Number(anchoMm), sucursalId: sucursal };
}

/** Apaga una impresora sin borrar su configuración. */
export async function desactivarImpresora(negocioId, impresoraId) {
  const r = await actualizarImpresora(negocioId, impresoraId, { activa: false });
  return r ? { ok: true } : { ok: false, error: 'Impresora no encontrada' };
}
