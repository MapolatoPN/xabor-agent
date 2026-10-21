// ─── El ticket del cliente de un pedido, por Xabor Edge ─────────────────────
//
// Decisión de Mario (21-oct-2026): el ticket automático (al cobrar y al
// corregir con ✏️ Pago) y el manual (🧾) tienen que ser EL MISMO, con el
// diseño de «Diseño de ticket y comanda». El panel los manda todos aquí
// (POST /api/pedidos/:folio/ticket). Si el negocio no puede imprimirlo por
// el Edge, la respuesta lo dice y el panel lo imprime con el navegador como
// siempre: un ticket nunca se queda sin salir.
//
// Va por el Edge solo si hay una impresora de Caja (ruta «cuenta») cuyo
// equipo está conectado AHORA y tiene Xabor Edge 1.2.0 o más. Un Edge 1.1.0
// imprimiría un ticket con menos datos que el del navegador, y uno apagado lo
// dejaría esperando con el cliente enfrente.
//
// Los datos salen de pedidos_activos (lo que quedó registrado al cobrar,
// billete y pago mixto incluidos), nunca del navegador.
import { randomUUID } from 'node:crypto';
import { pool } from '../services/database.js';
import { crearTrabajosDeDocumento, cargarDisenoDeNegocio, resolverSucursal } from '../services/impresionService.js';
import { compararVersiones } from './actualizacionesEdge.js';

export const VERSION_MINIMA_EDGE = '1.2.0';

function errorCodigo(mensaje, code) {
  const e = new Error(mensaje);
  e.code = code;
  return e;
}

// Los datos del ticket, el monto en letra y el trabajo viven con el armado
// del papel (formato/ticketPedido.js): la vista previa del panel usa lo mismo.
export { enLetras, montoEnLetra, lineasDeDireccion, datosDeTicketDePedido, payloadDeTicketDePedido } from './formato/ticketPedido.js';
import { datosDeTicketDePedido, payloadDeTicketDePedido } from './formato/ticketPedido.js';

// ── ¿Puede salir por el Edge? ───────────────────────────────────────────────

// Impresoras de Caja en uso de la sucursal, con su equipo.
async function cajasDeLaSucursal(nid) {
  const sid = await resolverSucursal(nid, null);
  if (!sid) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT i.id, i.nombre, i.terminal_id
       FROM impresion_rutas r
       JOIN impresoras i ON i.id = r.impresora_id AND i.activa
       JOIN terminales t ON t.id = i.terminal_id AND t.activo
      WHERE r.negocio_id = $1 AND r.sucursal_id = $2 AND r.activa AND r.ambito = 'documento' AND r.clave = 'cuenta'`,
    [nid, sid]);
  return rows;
}

// `estadoTerminal(id)` → { conectado, version } (lo pone server.js con el socket).
export async function motivoParaNoUsarEdge(nid, estadoTerminal) {
  const cajas = await cajasDeLaSucursal(nid);
  if (!cajas.length) return 'sin_caja';
  const estados = cajas.map((c) => { try { return estadoTerminal(c.terminal_id) || {}; } catch { return {}; } });
  if (!estados.some((e) => e.conectado)) return 'caja_desconectada';
  if (!estados.some((e) => e.conectado && compararVersiones(e.version, VERSION_MINIMA_EDGE) >= 0)) return 'edge_anterior';
  return null;
}

// Para el panel: ¿este negocio imprime hoy el ticket por el Edge? Lo pregunta
// cada minuto, y así un negocio sin Edge sigue abriendo la ventana del
// navegador en el mismo clic, sin esperar a la red (si se esperara, el
// navegador podría bloquearla).
export async function ticketPorEdge(negocioId, estadoTerminal) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw errorCodigo('negocioId requerido', 'TENANT_CONTEXT_REQUIRED');
  const motivo = await motivoParaNoUsarEdge(negocioId.trim(), estadoTerminal);
  return { porEdge: motivo === null, motivo };
}

const INTENTO_RE = /^[A-Za-z0-9-]{8,64}$/;

export async function imprimirTicketDePedido({ negocioId, folio, intento = null, estadoTerminal = () => ({}), autofactura = null }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw errorCodigo('negocioId requerido', 'TENANT_CONTEXT_REQUIRED');
  const nid = negocioId.trim();
  const f = String(folio || '').trim();
  if (!f) throw errorCodigo('folio requerido', 'FOLIO_REQUERIDO');

  const { rows: [fila] } = await pool.query(
    `SELECT estado, datos FROM pedidos_activos WHERE negocio_id = $1 AND folio = $2`, [nid, f]);
  if (!fila) throw errorCodigo('Pedido no encontrado', 'PEDIDO_NO_ENCONTRADO');
  if (fila.estado === 'cancelado') throw errorCodigo('El pedido está cancelado', 'PEDIDO_CANCELADO');

  const motivo = await motivoParaNoUsarEdge(nid, estadoTerminal);
  if (motivo) return { porEdge: false, motivo, trabajos: [] };

  const p = { ...(fila.datos || {}), id: f };
  const pagado = p.pago_confirmado === true || (p.forma_pago && p.forma_pago !== 'por_cobrar');
  let qr = null;
  if (pagado && typeof autofactura === 'function') {
    try { qr = await autofactura(nid, f); } catch { qr = null; }
  }
  const d = datosDeTicketDePedido(p, { autofactura: qr });
  const diseno = await cargarDisenoDeNegocio(nid);
  // Cada toque del botón es un ticket; el `intento` (uno por toque, lo pone el
  // panel) evita que un reintento de red saque dos del mismo toque.
  const origenId = `${f}#${INTENTO_RE.test(String(intento || '')) ? intento : randomUUID()}`;
  const r = await crearTrabajosDeDocumento({
    negocioId: nid, documento: 'cuenta', origenTipo: 'pedido_ticket', origenId,
    payload: payloadDeTicketDePedido(d, { folio: f, negocio: diseno.negocio?.nombreCorto || diseno.negocio?.nombre }),
  });
  if (r.error) throw errorCodigo('No se pudo crear el ticket', 'TRABAJO_NO_PERSISTIDO');
  const trabajos = [...r.creados, ...r.duplicados];
  if (!trabajos.length && !r.enEspera.length) return { porEdge: false, motivo: 'sin_caja', trabajos: [] };
  return {
    porEdge: true,
    trabajos: r.creados,
    impresoras: [...new Set(trabajos.map((t) => t.impresora_nombre))],
    enEspera: r.enEspera.map((e) => e.impresoraNombre ?? e.impresoraId),
    repetido: !r.creados.length && r.duplicados.length > 0,
  };
}
