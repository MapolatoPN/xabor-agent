// Vista de consulta: listas blancas, sin tokens de checkout/pago ni efectos.
import { esPagoPorEnlace } from '../orders/pagoPorEnlace.js';
import { TZ_DEFAULT, esZonaValida } from './zonaHoraria.js';
const texto = valor => typeof valor === 'string' ? valor : '';
const verdadero = valor => valor === true || valor === 'true';
const importe = valor => Number.isFinite(Number(valor)) ? Number(valor) : 0;

export function estadoPagoProgramado(pedido = {}) {
  if (['cancelado','expirado'].includes(pedido.estado)) return 'cancelado';
  if (verdadero(pedido.pago_confirmado)) return 'pagado';
  if (pedido.estado === 'pendiente_pago' || verdadero(pedido.requierePagoAnticipado)
    || esPagoPorEnlace(pedido.forma_pago_tipo) || esPagoPorEnlace(pedido.forma_pago)) return 'pendiente';
  if (/^(efectivo|terminal(?: \(tarjeta presente\))?|tarjeta con terminal|contra entrega|por_cobrar|pago en sucursal)$/i.test(texto(pedido.forma_pago))) return 'al_recibir';
  return 'por_verificar';
}

export function programadoParaConsulta(fila, cfg = {}) {
  const p = fila.datos || {}, c = p.cliente || {};
  let reglas = {};
  try { reglas = JSON.parse(cfg.reglas_atencion || '{}'); } catch { /* zona por defecto */ }
  const zona = esZonaValida(reglas?.timezone) ? reglas.timezone : TZ_DEFAULT;
  const fecha = p.programado_para || fila.programado_para;
  const instante = new Date(fecha);
  return {
    folio: fila.folio,
    negocio_id: fila.negocio_id,
    programado_id: fila.programado_id || p.programado_id || null,
    programado_para: Number.isFinite(instante.getTime()) ? instante.toISOString() : null,
    timezone: zona,
    negocio: texto(cfg.nombre_corto) || texto(cfg.nombre) || 'Xabor',
    cliente: texto(c.nombre) || '—', telefono: texto(c.telefono),
    direccion: [texto(c.calle),texto(c.numero_exterior),c.numero_interior ? `Int. ${texto(c.numero_interior)}` : '',texto(c.colonia)].filter(Boolean).join(', ')
      || texto(c.direccion) || texto(p.direccion),
    referencias: [texto(c.entre_calles),texto(c.referencia) || texto(c.referencias)].filter(Boolean).join('. '),
    modalidad: texto(p.modalidad), notas: texto(p.nota_pedido) || texto(p.notas),
    forma_pago: texto(p.forma_pago), pago_confirmado: verdadero(p.pago_confirmado),
    estado_pago: estadoPagoProgramado(p), estado: texto(p.estado),
    subtotal: importe(p.subtotal), costo_envio: importe(p.costo_envio), total: importe(p.total),
    items: (Array.isArray(p.items) ? p.items : []).filter(i=>i && typeof i==='object').map(i => ({
      nombre: texto(i.nombre) || texto(i.producto) || 'Producto', cantidad: importe(i.cantidad),
      precio_unitario: importe(i.precio_unitario ?? i.precio_base ?? i.precio), notas: texto(i.notas),
      modificadores: (Array.isArray(i.modificadores) ? i.modificadores : []).filter(m=>m && typeof m==='object').map(m => ({grupo:texto(m.grupo),opcion:texto(m.opcion)})),
    })),
  };
}
