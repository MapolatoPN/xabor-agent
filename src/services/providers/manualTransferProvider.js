/**
 * manualTransferProvider.js — Transferencia bancaria manual, un método
 * "sin API": no crea enlaces reales ni cobra nada por sí mismo. Solo
 * expone las instrucciones (titular/banco/cuenta/CLABE) configuradas por
 * el propio negocio para que el agente/operador las comparta con el
 * cliente. Nunca marca un pago como confirmado automáticamente -- queda
 * en 'requiere_revision' hasta que un humano lo concilie manualmente
 * (fuera de alcance de este encargo: recepción/validación de comprobantes).
 */

export async function createPaymentLink({ credenciales }) {
  // No hay "link" real -- se devuelve un marcador para que pagosService.js
  // registre el pago en estado 'requiere_revision' en vez de 'pendiente'
  // (que implica un checkout externo real). `credenciales` aquí son los
  // datos de la cuenta (titular/banco/clabe) guardados vía
  // guardarIntegracionPago -- se devuelven como instrucciones para que el
  // llamador se las comparta al cliente.
  return { referenciaExterna: null, url: null, estado: 'requiere_revision', instrucciones: credenciales };
}

export async function getPaymentStatus() {
  // Nunca se auto-confirma -- la transferencia manual solo la marca
  // pagada un humano desde el panel (fuera de alcance: endpoint de
  // conciliación manual explícita, no un webhook).
  return null;
}

export async function cancelPayment() {
  return { ok: true };
}

export function verifyWebhook() {
  return { verificado: false, motivo: 'transferencia manual no tiene webhook -- no aplica' };
}

export async function testConnection(credenciales) {
  const camposMinimos = credenciales?.titular && credenciales?.banco && credenciales?.clabe;
  return camposMinimos
    ? { ok: true, motivo: 'datos de la cuenta completos' }
    : { ok: false, motivo: 'faltan titular/banco/CLABE' };
}

export function getCapabilities() {
  return { createLink: false, getStatus: false, cancelLink: false, webhookSignature: false, manual: true };
}
