// Cliente mínimo de Facturapi. Toda operación exige negocioId y resuelve la
// llave cifrada de ese negocio; no existe respaldo global.
import { obtenerCredencialesFacturapiDescifradas } from './integracionesService.js';
import { REGIMENES_SAT, USOS_CFDI_SAT } from './catalogosSat.js';

const BASE = 'https://www.facturapi.io/v2';

export class FacturapiNoConfiguradoError extends Error {
  constructor() {
    super('Este negocio no tiene una cuenta de Facturapi activa.');
    this.name = 'FacturapiNoConfiguradoError';
    this.codigo = 'FACTURAPI_NO_CONFIGURADO';
  }
}

export class FacturapiError extends Error {
  constructor(message, { status = 502, codigo = 'FACTURAPI_ERROR', detalle = null } = {}) {
    super(message || 'Facturapi rechazó la operación.');
    this.name = 'FacturapiError';
    this.status = status;
    this.codigo = codigo;
    this.detalle = detalle;
  }
}

async function claveDe(negocioId) {
  const credenciales = await obtenerCredencialesFacturapiDescifradas(negocioId);
  if (!credenciales?.apiKey) throw new FacturapiNoConfiguradoError();
  return credenciales.apiKey;
}

// Opciones (todas opcionales, los llamadores existentes no cambian):
//   timeoutMs  -> AbortSignal.timeout; al vencer lanza FACTURAPI_TIMEOUT
//   conStatus  -> devuelve { status, body } en vez de solo el cuerpo (200 vs 202)
//   body string -> se manda tal cual (para reenviar un snapshot byte a byte)
async function apiCall(negocioId, method, path, body, { respuesta = 'json', timeoutMs = null, conStatus = false } = {}) {
  const apiKey = await claveDe(negocioId);
  let resp;
  try {
    resp = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'es',
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (e) {
    const agotado = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new FacturapiError(
      agotado ? 'Facturapi no respondió a tiempo.' : 'No fue posible comunicarse con Facturapi.',
      { codigo: agotado ? 'FACTURAPI_TIMEOUT' : 'FACTURAPI_NO_DISPONIBLE', detalle: e.message });
  }
  if (!resp.ok) {
    const detalle = await resp.json().catch(() => ({}));
    const mensaje = detalle?.message || detalle?.error || `Facturapi respondió ${resp.status}`;
    throw new FacturapiError(mensaje, { status: resp.status, codigo: detalle?.code || 'FACTURAPI_RECHAZO', detalle });
  }
  if (respuesta === 'arrayBuffer') return resp.arrayBuffer();
  const cuerpo = resp.status === 204 ? null : await resp.json();
  return conStatus ? { status: resp.status, body: cuerpo } : cuerpo;
}

export function mapFormaPago(forma) {
  const f = String(forma || '').trim().toLowerCase().replace(/_/g, ' ');
  if (f === 'efectivo') return '01';
  if (f.includes('transfer')) return '03';
  if (f.includes('crédito') || f.includes('credito') || f.includes('enlace')) return '04';
  if (f.includes('débito') || f.includes('debito') || f.includes('terminal')) return '28';
  if (f === 'mixto' || f === 'multiple' || f === 'múltiple') return '99';
  return '99';
}

export function construirConceptoVenta(pedido, { ivaTasa, claveRestaurante = '90101501', claveParaLlevar = '90101800' } = {}) {
  const tasa = Number(ivaTasa);
  if (![0, 0.08, 0.16].includes(tasa)) {
    const e = new Error('Configura la tasa de IVA del negocio antes de emitir.');
    e.codigo = 'IVA_NO_CONFIGURADO';
    throw e;
  }
  const total = Number(pedido?.total);
  if (!Number.isFinite(total) || total <= 0) {
    const e = new Error('El pedido no tiene un total facturable.');
    e.codigo = 'TOTAL_NO_FACTURABLE';
    throw e;
  }
  const modalidad = String(pedido?.modalidad || pedido?.tipo || '').toLowerCase();
  const enRestaurante = ['mesa', 'restaurante', 'comer aqui', 'comer aquí'].some(v => modalidad.includes(v));
  const folio = String(pedido?.folio || pedido?.id || '').trim();
  const product = {
    description: `Consumo de alimentos y bebidas${folio ? ` · ${folio}` : ''}`,
    product_key: enRestaurante ? claveRestaurante : claveParaLlevar,
    unit_key: 'E48',
    unit_name: 'Unidad de servicio',
    price: Math.round(total * 100) / 100,
    tax_included: true,
    taxes: [{ type: 'IVA', rate: tasa }],
  };
  return { quantity: 1, product };
}

export async function puedeFacturar(negocioId) {
  try { return !!(await obtenerCredencialesFacturapiDescifradas(negocioId))?.apiKey; }
  catch { return false; }
}

export async function crearRecibo(negocioId, pedido, config = {}) {
  const folio = String(pedido?.folio || pedido?.id || '').trim();
  if (!folio) throw new Error('Folio requerido para crear el recibo.');
  const idempotencyKey = `xabor:${negocioId}:${folio}`;
  return apiCall(negocioId, 'POST', '/receipts', {
    items: [construirConceptoVenta(pedido, config)],
    payment_form: mapFormaPago(pedido?.forma_pago || pedido?.cliente?.forma_pago),
    currency: 'MXN',
    external_id: folio,
    idempotency_key: idempotencyKey,
  });
}

/**
 * CFDI de ingreso directo (POST /invoices), sin E-Receipts. `payload` puede
 * ser el objeto o el JSON ya serializado (el snapshot de un intento, para
 * reenviarlo byte a byte con la misma idempotency_key). Devuelve
 * { status, body } para que el llamador distinga 200 (timbrada) de 202
 * (pendiente). Cualquier respuesta no 2xx lanza FacturapiError con su
 * status; timeout y red caída lanzan FACTURAPI_TIMEOUT / FACTURAPI_NO_DISPONIBLE.
 */
export async function crearFacturaDirecta(negocioId, payload, { timeoutMs = 30000 } = {}) {
  if (!payload || (typeof payload !== 'object' && typeof payload !== 'string')) {
    throw new Error('crearFacturaDirecta: payload requerido');
  }
  return apiCall(negocioId, 'POST', '/invoices', payload, { conStatus: true, timeoutMs });
}

export async function obtenerRecibo(negocioId, reciboId) {
  return apiCall(negocioId, 'GET', `/receipts/${encodeURIComponent(reciboId)}`);
}

export async function obtenerFactura(negocioId, facturaId) {
  return apiCall(negocioId, 'GET', `/invoices/${encodeURIComponent(facturaId)}`);
}

export async function facturarRecibo(negocioId, reciboId, clienteCFDI, { serie = null } = {}) {
  const customer = {
    legal_name: String(clienteCFDI.nombre_fiscal || clienteCFDI.razon_social || '').trim().toUpperCase(),
    tax_id: String(clienteCFDI.rfc || '').trim().toUpperCase(),
    tax_system: String(clienteCFDI.regimen || '').trim(),
    default_invoice_use: String(clienteCFDI.uso_cfdi || '').trim(),
    address: { zip: String(clienteCFDI.cp || '').trim() },
    ...(clienteCFDI.email ? { email: String(clienteCFDI.email).trim() } : {}),
    ...(clienteCFDI.telefono ? { phone: String(clienteCFDI.telefono).replace(/\D/g, '') } : {}),
  };
  return apiCall(negocioId, 'POST', `/receipts/${encodeURIComponent(reciboId)}/invoice`, {
    customer,
    use: String(clienteCFDI.uso_cfdi || '').trim(),
    ...(serie ? { series: String(serie).trim() } : {}),
  });
}

export async function enviarFacturaPorEmail(negocioId, facturaId, email) {
  return apiCall(negocioId, 'POST', `/invoices/${encodeURIComponent(facturaId)}/email`, { email });
}

export async function descargarFacturaPDF(negocioId, facturaId) {
  return apiCall(negocioId, 'GET', `/invoices/${encodeURIComponent(facturaId)}/pdf`, undefined, { respuesta: 'arrayBuffer' });
}

// Catálogos SAT: la única fuente es catalogosSat.js (completos, con
// aplicabilidad por tipo de persona). Aquí solo se conserva la forma
// {clave, desc} que este módulo exponía.
export const USOS_CFDI = USOS_CFDI_SAT.map((u) => ({ clave: u.clave, desc: u.nombre }));
export const REGIMENES = REGIMENES_SAT.map((r) => ({ clave: r.clave, desc: r.nombre }));
