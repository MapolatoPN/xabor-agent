/**
 * draftBuilder.js — Fase 3 del Asistente Comercial de Cotizaciones por
 * WhatsApp. Convierte una sesión comercial con "información suficiente"
 * en una cotización real en estado 'borrador', usando el módulo de
 * cotizaciones YA EXISTENTE (crearCotizacion) -- no reinventa el CRUD ni
 * el versionado.
 *
 * Nunca inventa precios ni productos (contrato de seguridad del
 * encargo): cada producto/servicio mencionado por el cliente se busca en
 * el catálogo real del negocio (menu_productos, scoped por negocio_id).
 * Si no hay coincidencia, la partida se crea con precio_unitario = 0 y
 * queda marcada como pendiente de revisión -- nunca se asigna un precio
 * generado por el modelo. El panel (Fase 4) resalta estas partidas para
 * que el administrador las complete antes de aprobar.
 *
 * NUNCA llama a marcarCotizacionEnviada ni a ningún endpoint de envío --
 * la única vía de 'borrador' a 'enviada' es la acción humana explícita en
 * POST /api/cotizaciones/:id/enviar (Fase 5).
 *
 * No importa nada de server.js a propósito (mismo criterio que
 * intentDetector.js) -- se puede probar de forma aislada, solo con DB.
 */
import { pool, crearCotizacion } from './database.js';
import { obtenerSesion, cambiarEstadoSesion, vincularCotizacion } from './sesionComercial.js';
import { camposObligatoriosCompletos } from '../agent/comercialMarkers.js';
import { TenantContextRequiredError } from './integracionesService.js';

/**
 * Busca en el catálogo real del negocio (menu_productos, disponible=true)
 * una coincidencia por nombre (ILIKE, insensible a mayúsculas/acentos
 * exactos) para la descripción capturada. Devuelve el precio real si hay
 * coincidencia, o null si no la hay -- nunca un precio inventado.
 */
async function buscarPrecioCatalogo(negocioId, descripcion) {
  if (typeof descripcion !== 'string' || !descripcion.trim()) return null;
  const { rows } = await pool.query(
    `SELECT precio FROM menu_productos
     WHERE negocio_id = $1 AND disponible = true AND nombre ILIKE $2
     ORDER BY length(nombre) ASC
     LIMIT 1`,
    [negocioId, `%${descripcion.trim()}%`]
  );
  return rows[0] ? Number(rows[0].precio) : null;
}

/**
 * Construye los items de cotizacion_items a partir de los items
 * capturados por el asistente -- consulta el catálogo, nunca inventa.
 * Marca cada item con `precioPendiente: true` cuando no hubo coincidencia
 * en el catálogo, para que Fase 4 (panel) lo resalte.
 */
async function construirItemsConPrecio(negocioId, itemsCapturados) {
  const items = [];
  for (const it of itemsCapturados) {
    const precio = await buscarPrecioCatalogo(negocioId, it.descripcion);
    items.push({
      tipo: 'servicio',
      descripcion: precio === null ? `${it.descripcion} (precio pendiente de revisión)` : it.descripcion,
      cantidad: Number(it.cantidad) || 1,
      precioUnitario: precio ?? 0,
    });
  }
  return items;
}

function construirNotas(camposCapturados) {
  const lineas = ['Solicitud generada por el Asistente Comercial de WhatsApp.'];
  if (camposCapturados.nombre) lineas.push(`Cliente: ${camposCapturados.nombre}`);
  if (camposCapturados.presupuesto) lineas.push(`Presupuesto aproximado indicado: ${camposCapturados.presupuesto}`);
  if (camposCapturados.observaciones) lineas.push(`Observaciones: ${camposCapturados.observaciones}`);
  return lineas.join('\n');
}

/**
 * Punto de entrada: crea el borrador si y solo si hay información
 * suficiente (camposObligatoriosCompletos) y la sesión aún no tiene una
 * cotización vinculada (idempotente -- una sesión nunca genera dos
 * borradores). Devuelve la cotización creada, la ya existente si era
 * idempotente, o null si todavía no hay información suficiente.
 */
export async function generarBorradorDesdeSesion(sesionId, negocioId, camposCapturadosOverride = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new TenantContextRequiredError('generarBorradorDesdeSesion');
  }
  const sesion = await obtenerSesion(sesionId, negocioId);
  if (!sesion) return null; // sesión inexistente o de otro negocio -- nada que hacer

  if (sesion.cotizacion_id) {
    // Ya se generó un borrador para esta sesión -- idempotente, no se
    // crea un segundo aunque el modelo vuelva a emitir <BORRADOR_LISTO>.
    return { yaExistia: true, cotizacionId: sesion.cotizacion_id };
  }

  const campos = camposCapturadosOverride || sesion.campos_capturados;
  if (!camposObligatoriosCompletos(campos)) {
    console.log(`[draftBuilder] Sesión ${sesionId}: información aún insuficiente, no se crea borrador.`);
    return null;
  }

  await cambiarEstadoSesion(sesionId, negocioId, 'construyendo_borrador', { motivo: 'borrador_listo_recibido' });

  const items = await construirItemsConPrecio(negocioId, campos.items);
  const cotizacion = await crearCotizacion({
    negocioId,
    telefono: sesion.telefono,
    createdBy: null,
    evento: {
      fecha: campos.fecha_evento || null,
      lugar: campos.lugar || null,
      cantidadPersonas: Number(campos.numero_personas) || null,
    },
    notas: construirNotas(campos),
    items,
    origen: 'whatsapp_ia',
  });

  await vincularCotizacion(sesionId, negocioId, cotizacion.id);
  await cambiarEstadoSesion(sesionId, negocioId, 'esperando_aprobacion', { cotizacionId: cotizacion.id });

  return cotizacion;
}
