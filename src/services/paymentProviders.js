/**
 * paymentProviders.js — Registro de proveedores de pago multiempresa.
 *
 * Interfaz común que cualquier adaptador debe implementar:
 *   createPaymentLink({ negocioId, credenciales, pedidoId, total, descripcion, cliente })
 *   getPaymentStatus(linkId, credenciales)
 *   cancelPayment(linkId, credenciales)      -- opcional, no todo proveedor lo soporta
 *   verifyWebhook(req, credenciales)          -- valida firma/autenticidad, nunca confía ciegamente
 *   testConnection(credenciales)              -- prueba real mínima (o mock en tests), sin cobrar
 *   getCapabilities()                         -- describe qué soporta, para la UI y el agente
 *
 * `implementado: false` marca un adaptador que SOLO declara su forma
 * (campos de configuración, capacidades) pero no tiene lógica real --
 * nunca debe poder activarse (ver validarPuedeActivarse). Esto evita
 * "fingir" una integración que no existe (instrucción explícita del
 * encargo): la UI los muestra como "Próximamente" y el backend rechaza
 * cualquier intento de guardar credenciales para ellos.
 */
import * as clipAdapter from './providers/clipProvider.js';
import * as manualTransferAdapter from './providers/manualTransferProvider.js';
import * as mercadoPagoAdapter from './providers/mercadoPagoProvider.js';

const PROVEEDORES = {
  clip: {
    nombre: 'Clip',
    implementado: true,
    requiereCredenciales: true,
    camposConfiguracion: ['apiKey', 'apiSecret'],
    adaptador: clipAdapter,
  },
  manual_transfer: {
    nombre: 'Transferencia manual',
    implementado: true,
    requiereCredenciales: false, // no es una API -- ver metodos_pago.instrucciones
    camposConfiguracion: ['titular', 'banco', 'cuentaVisible', 'clabe', 'referenciaRequerida'],
    adaptador: manualTransferAdapter,
  },
  mercado_pago: {
    nombre: 'Mercado Pago',
    implementado: true,
    requiereCredenciales: true,
    // webhookSecret es el que MP entrega al configurar notificaciones: sin el,
    // verifyWebhook falla cerrado y ningun webhook se considera verificado.
    camposConfiguracion: ['accessToken', 'publicKey', 'webhookSecret'],
    adaptador: mercadoPagoAdapter,
  },
  paypal: {
    nombre: 'PayPal',
    // Registrado con la forma correcta, NO implementado: la UI lo muestra como
    // "Proximamente" y validarPuedeActivarse impide guardar credenciales.
    // Fingir que funciona seria peor que no ofrecerlo.
    implementado: false,
    requiereCredenciales: true,
    camposConfiguracion: ['clientId', 'clientSecret', 'webhookId'],
    adaptador: null,
  },
  stripe: {
    nombre: 'Stripe',
    implementado: false,
    requiereCredenciales: true,
    camposConfiguracion: ['secretKey', 'publishableKey'],
    adaptador: null,
  },
  openpay: {
    nombre: 'Openpay',
    implementado: false,
    requiereCredenciales: true,
    camposConfiguracion: ['merchantId', 'privateKey', 'publicKey'],
    adaptador: null,
  },
  conekta: {
    nombre: 'Conekta',
    implementado: false,
    requiereCredenciales: true,
    camposConfiguracion: ['privateKey', 'publicKey'],
    adaptador: null,
  },
};

export function listarProveedores() {
  return Object.entries(PROVEEDORES).map(([id, p]) => ({
    id, nombre: p.nombre, implementado: p.implementado,
    requiereCredenciales: p.requiereCredenciales, camposConfiguracion: p.camposConfiguracion,
  }));
}

export function obtenerProveedor(id) {
  return PROVEEDORES[id] || null;
}

export function esProveedorValido(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROVEEDORES, id);
}

/** Nunca permite activar un proveedor sin adaptador real (evita "fingir" una integración). */
export function validarPuedeActivarse(id) {
  const p = PROVEEDORES[id];
  return !!p && p.implementado === true;
}

export function obtenerAdaptador(id) {
  const p = PROVEEDORES[id];
  if (!p || !p.implementado) return null;
  return p.adaptador;
}
