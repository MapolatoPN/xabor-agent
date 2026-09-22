import { pool, obtenerClientesFiscalesPorTelefono } from './database.js';
import {
  asegurarReciboPedido, obtenerPedidoFacturable, obtenerUltimoPedidoFacturablePorTelefono,
  pedidoPerteneceATelefono, normalizarFolioFactura,
} from './facturacionService.js';

/**
 * El aviso de reconocimiento, o cadena vacia si no aplica o si algo salio mal.
 *
 * PURAMENTE INFORMATIVO Y GENERICO: nunca factura nada, nunca elige una ficha
 * por el cliente, nunca inventa regimen ni uso de CFDI -- y desde esta
 * revision, TAMPOCO revela ningun dato fiscal guardado por WhatsApp. Ni RFC,
 * ni razon social, ni regimen, ni uso de CFDI. WhatsApp no es un canal
 * verificado como la sesion del panel ni la pagina propia de Facturapi: el
 * unico dato que viaja aqui es "existen datos previos, confirmalos en el
 * portal" -- el cliente los ve y los corrige EN Facturapi, nunca aqui.
 *
 * Tres casos, y solo tres:
 *   - ninguna ficha    -> sin aviso, el mensaje queda exactamente como antes.
 *   - UNA ficha         -> aviso generico de que hay datos previos.
 *   - dos o mas fichas  -> aviso de que hay varias opciones, sin elegir
 *                          ninguna ni decir cuantas ni cuales son. Adivinar
 *                          cual es la correcta seria facturar a nombre de
 *                          quien no compro.
 *
 * NUNCA LANZA. Esto corre DESPUES de que el recibo ya esta listo -- si la
 * consulta de clientes_fiscales revienta por lo que sea (un hipo de la base,
 * por ejemplo), eso no puede convertir una autofactura ya creada en un
 * "no pude preparar la factura" para el cliente. Se registra la falla y se
 * sigue sin aviso, exactamente como si no hubiera ficha alguna.
 */
async function avisoDeReconocimiento(negocioId, telefono) {
  let conocidos;
  try {
    conocidos = await obtenerClientesFiscalesPorTelefono(negocioId, telefono);
  } catch (e) {
    console.warn(`[Facturacion WA] avisoDeReconocimiento no pudo consultar clientes_fiscales `
      + `(negocio=${negocioId}): ${e.message}`);
    return '';
  }
  if (!conocidos.length) return '';
  if (conocidos.length === 1) {
    return '\n\nEncontramos datos fiscales utilizados anteriormente. '
      + 'Podrás confirmarlos o corregirlos en el portal de facturación.';
  }
  return '\n\nEncontramos varias opciones de datos fiscales utilizados anteriormente. '
    + 'Podrás confirmar la que corresponda en el portal de facturación.';
}

export function esSolicitudFactura(texto) {
  return /\b(factur(?:a|ar|aci[oó]n)|cfdi|comprobante\s+fiscal|ticket\s+para\s+facturar)\b/i.test(String(texto || ''));
}

export function extraerFolioFactura(texto, { permitirSoloNumero = false } = {}) {
  const t = String(texto || '').trim();
  const explicito = t.match(/\b(?:XAB\s*[- ]?\s*|folio\s*(?:XAB\s*[- ]?\s*)?)(\d{1,8})\b/i);
  if (explicito) return normalizarFolioFactura(explicito[0]);
  const juntoAFactura = t.match(/\b(?:factur(?:a|ar)|cfdi)\D{0,20}(\d{1,8})\b/i);
  if (juntoAFactura) return normalizarFolioFactura(juntoAFactura[1]);
  if (permitirSoloNumero && /^\d{1,8}$/.test(t)) return normalizarFolioFactura(t);
  return null;
}

async function estadoPendiente(negocioId, telefono) {
  const { rows } = await pool.query(
    `DELETE FROM facturacion_whatsapp_estado
      WHERE negocio_id=$1 AND telefono=$2 AND expires_at <= NOW()
      RETURNING 1`, [negocioId, telefono]);
  if (rows.length) return null;
  const r = await pool.query(
    `SELECT estado FROM facturacion_whatsapp_estado
      WHERE negocio_id=$1 AND telefono=$2 AND expires_at > NOW()`, [negocioId, telefono]);
  return r.rows[0]?.estado || null;
}

async function esperarFolio(negocioId, telefono) {
  await pool.query(
    `INSERT INTO facturacion_whatsapp_estado (negocio_id, telefono, estado, expires_at)
     VALUES ($1,$2,'esperando_folio',NOW()+INTERVAL '30 minutes')
     ON CONFLICT (negocio_id,telefono) DO UPDATE SET
       estado='esperando_folio', folio=NULL, expires_at=EXCLUDED.expires_at, updated_at=NOW()`,
    [negocioId, telefono]);
}

async function limpiarEstado(negocioId, telefono) {
  await pool.query('DELETE FROM facturacion_whatsapp_estado WHERE negocio_id=$1 AND telefono=$2', [negocioId, telefono]);
}

export async function manejarFacturacionWhatsapp({ negocioId, telefono, texto }) {
  const solicitud = esSolicitudFactura(texto);
  const pendiente = await estadoPendiente(negocioId, telefono);
  if (!solicitud && pendiente !== 'esperando_folio') return { manejado: false };

  let folio = extraerFolioFactura(texto, { permitirSoloNumero: pendiente === 'esperando_folio' });
  let pedido = null;
  if (folio) {
    try { pedido = await obtenerPedidoFacturable(negocioId, folio); }
    catch (e) {
      if (e.codigo === 'PEDIDO_NO_ENCONTRADO') {
        return { manejado: true, mensaje: `No encontré la venta ${folio}. Revisa el folio del ticket y envíamelo otra vez.` };
      }
      return { manejado: true, mensaje: e.message };
    }
    if (!pedidoPerteneceATelefono(pedido, telefono)) {
      await esperarFolio(negocioId, telefono);
      return { manejado: true, mensaje: 'Ese folio no está asociado a este WhatsApp. Envíame el folio de tu propio ticket o pide ayuda al personal.' };
    }
  } else {
    pedido = await obtenerUltimoPedidoFacturablePorTelefono(negocioId, telefono);
    folio = pedido?.folio || null;
  }

  if (!pedido || !folio) {
    await esperarFolio(negocioId, telefono);
    return { manejado: true, mensaje: 'Claro. Envíame el folio de tu ticket, por ejemplo: XAB-0458.' };
  }

  try {
    const recibo = await asegurarReciboPedido(negocioId, folio);
    await limpiarEstado(negocioId, telefono);
    if (recibo.estado === 'facturado') {
      return { manejado: true, mensaje: `La venta ${folio} ya fue facturada. Si necesitas que te reenvíen el CFDI, nuestro personal puede ayudarte.` };
    }
    if (recibo.estado !== 'abierto' || !recibo.url_autofactura) {
      return { manejado: true, escalar: true, mensaje: 'No pude preparar la factura en este momento. Dejé la conversación para que la revise el personal.' };
    }
    const vigencia = recibo.expires_at
      ? `\nVigente en el portal hasta: ${new Date(recibo.expires_at).toLocaleDateString('es-MX')}.`
      : '';
    // El reconocimiento se agrega DESPUES de que el recibo esta listo: si
    // algo falla antes (pedido no pagado, negocio sin Facturapi, IVA sin
    // configurar), el cliente nunca llega a ver un mensaje sobre datos
    // fiscales que no tiene sentido en ese momento.
    const aviso = await avisoDeReconocimiento(negocioId, telefono);
    return {
      manejado: true,
      mensaje: `Para facturar la venta ${folio}, captura tus datos fiscales aquí:\n${recibo.url_autofactura}\n\nClave: ${recibo.clave}${vigencia}${aviso}`,
    };
  } catch (e) {
    return { manejado: true, escalar: true, mensaje: 'No pude preparar la factura en este momento. Dejé la conversación para que la revise el personal.', error: e };
  }
}
