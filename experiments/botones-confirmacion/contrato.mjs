// Prueba aislada: NO importar desde el webhook ni usar como autorización de pedido.
// Este módulo construye y prevalida. No persiste, consume, envía ni ejecuta.
import { randomBytes } from 'node:crypto';
import { huellaDelResumen } from '../../src/mesero-whatsapp/resumenDelPedido.js';

const TOKEN = /^xb1:[A-Za-z0-9_-]{22}$/;
const textoValido = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const copia = v => JSON.parse(JSON.stringify(v));

export function ventanaAbierta(ultimoMensajeClienteMs, ahoraMs) {
  return Number.isFinite(ultimoMensajeClienteMs) && Number.isFinite(ahoraMs)
    && ahoraMs >= ultimoMensajeClienteMs && ahoraMs - ultimoMensajeClienteMs < 24 * 60 * 60 * 1000;
}

// Recibe texto/resumen canónicos de Xabor, no prosa del modelo como autorización.
export function prepararConfirmacion({ negocioId, clienteId, ciclo, dialogoId, outboxClave,
  resumen, texto, pedidoConfirmable, ultimoMensajeClienteMs, ahoraMs }) {
  if (![negocioId, clienteId, ciclo, dialogoId, outboxClave].every(v => textoValido(v, 256))
    || !textoValido(texto, 1024) || pedidoConfirmable !== true
    || !ventanaAbierta(ultimoMensajeClienteMs, ahoraMs)) return null;
  if (!Array.isArray(resumen?.items) || resumen.items.length === 0) return null;
  const huella = huellaDelResumen(resumen);
  const asociaciones = [['confirmar', 'Confirmar'], ['cambiar_algo', 'Cambiar algo']]
    .map(([accion, titulo]) => ({ token: `xb1:${randomBytes(16).toString('base64url')}`,
      negocioId, clienteId, ciclo, dialogoId, outboxClave, accion, titulo,
      huella, resumen: copia(resumen) }));
  return {
    interactivo: { type: 'button', body: { text: texto }, action: {
      buttons: asociaciones.map(a => ({ type: 'reply', reply: { id: a.token, title: a.titulo } })),
    } },
    asociaciones,
  };
}

// El adaptador futuro debe autenticar la firma de Meta y resolver el negocio
// por el phone_number_id. Este parser NO autentica un webhook.
export function leerToque(mensaje) {
  if (mensaje?.type !== 'interactive' || mensaje.interactive?.type !== 'button_reply') return null;
  const b = mensaje.interactive.button_reply;
  if (!textoValido(mensaje.id, 256) || !textoValido(mensaje.from, 256)
    || !textoValido(mensaje.context?.id, 256) || typeof b?.id !== 'string' || !TOKEN.test(b.id)) return null;
  return { token: b.id, wamid: mensaje.id, remitente: mensaje.from,
    contextoId: mensaje.context.id };
}

// Recibe UN lote ya formado por la cola; no implementa los seis segundos.
// Medios, plantillas, eventos desconocidos o malformados también impiden ejecutar toques.
export function separarLote(mensajes) {
  const toques = mensajes.map(leerToque).filter(Boolean);
  const otros = mensajes.filter(m => !leerToque(m));
  return { toques, otros, texto: otros.filter(m => m?.type === 'text')
    .map(m => typeof m.text?.body === 'string' ? m.text.body : '').filter(Boolean).join('\n'),
  ejecutarToques: otros.length === 0 && toques.length > 0 };
}

// Solo una PREVALIDACIÓN: el consumidor durable debe repetirla bajo exclusión
// por pregunta, reservar ANTES de efectos y conciliar. Un resultado válido NO
// permite llamar directamente a registrarPedido. No hay garantías de concurrencia aquí.
export function prevalidarToque({ toque, asociacion: a, actual, barreras, pregunta, salida,
  loteMixto = false }) {
  const no = motivo => ({ estado: 'ignorar', motivo });
  if (barreras?.botActivo !== true || barreras?.sinPausa !== true || barreras?.sinHumano !== true
    || barreras?.enCanario !== true || actual?.cicloAbierto !== true) return no('barrera_de_atencion');
  if (!toque || !a || !TOKEN.test(a.token) || a.token !== toque.token) return no('token_desconocido');
  if (!actual || a.negocioId !== actual.negocioId || a.clienteId !== actual.clienteId
    || toque.remitente !== actual.clienteId) return no('identidad_ajena');
  if (a.ciclo !== actual.ciclo) return no('ciclo_ajeno');
  // Estado de consumo explícito: no asumir que un registro faltante está libre.
  if (!pregunta || pregunta.negocioId !== a.negocioId || pregunta.clienteId !== a.clienteId
    || pregunta.ciclo !== a.ciclo || pregunta.dialogoId !== a.dialogoId) return no('pregunta_ausente');
  if (pregunta.estado !== 'disponible' || pregunta.respuestaRegistrada !== false) return no('pregunta_ocupada');
  if (a.dialogoId !== actual.dialogoId || actual.pendiente !== 'confirmar_resumen') {
    return { estado: 'requiere_aviso_unico', motivo: 'pregunta_reemplazada' };
  }
  if (loteMixto) return { estado: 'atender_texto', motivo: 'lote_mixto' };
  if (barreras.interactivosProceso !== true || barreras.interactivosNegocio !== true) {
    return { estado: 'requiere_aviso_unico', motivo: 'funcion_apagada' };
  }
  if (!salida || salida.clave !== a.outboxClave) return no('salida_ajena');
  if (salida.estado === 'pendiente') return { estado: 'requiere_retencion', motivo: 'sin_acuse' };
  if (salida.estado !== 'enviada' || !textoValido(salida.wamid, 256)
    || salida.wamid !== toque.contextoId) return no('acuse_invalido');
  if (!['confirmar', 'cambiar_algo'].includes(a.accion)) return no('accion_no_soportada');
  if (actual.pedidoConfirmable !== true || actual.cartaVigente !== true) return no('pedido_no_validado');
  if (a.huella !== huellaDelResumen(actual.resumen)) {
    return { estado: 'requiere_aviso_unico', motivo: 'resumen_cambiado' };
  }
  return { estado: 'requiere_reserva_durable', accion: a.accion,
    clavePregunta: [a.negocioId, a.clienteId, a.ciclo, a.dialogoId], huella: a.huella };
}
