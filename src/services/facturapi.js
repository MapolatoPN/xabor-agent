import { getIntegracion } from '../server.js';
// Servicio Facturapi — generación de CFDI timbrados por el SAT
// Documentación: https://www.facturapi.io/docs

const BASE = 'https://www.facturapi.io/v2';

function key() {
  return getIntegracion('facturapi_key') || process.env.FACTURAPI_KEY;
}

async function apiCall(method, path, body) {
  if (!key()) throw new Error('FACTURAPI_KEY no configurada');
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${key()}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.message || `Facturapi ${resp.status}`);
  }
  return resp.json();
}

// Mapa forma de pago Xabor → clave SAT
function mapFormaPago(forma) {
  const mapa = {
    'efectivo':      '01',
    'terminal':      '28',
    'enlace de pago':'04',
    'tarjeta':       '04'
  };
  return mapa[(forma||'').toLowerCase()] || '99'; // 99 = por definir
}

// Mapa uso CFDI — los más comunes en restaurantes
export const USOS_CFDI = [
  { clave: 'G01', desc: 'Adquisición de mercancias' },
  { clave: 'G03', desc: 'Gastos en general' },
  { clave: 'D01', desc: 'Honorarios médicos, dentales y hospitalarios' },
  { clave: 'S01', desc: 'Sin efectos fiscales' }
];

// Regímenes fiscales más comunes
export const REGIMENES = [
  { clave: '626', desc: 'Simplificado de Confianza (RESICO)' },
  { clave: '612', desc: 'Personas físicas con actividades empresariales' },
  { clave: '601', desc: 'General de Ley Personas Morales' },
  { clave: '621', desc: 'Incorporación Fiscal' }
];

// Código SAT para alimentos preparados (restaurantes)
const CLAVE_PROD_ALIMENTOS = '90111501';

export async function generarFactura(pedido, clienteCFDI) {
  // Crear o localizar cliente en Facturapi
  const customerPayload = {
    legal_name: clienteCFDI.nombre_fiscal,
    tax_id:     clienteCFDI.rfc,
    tax_system: clienteCFDI.regimen || '626',
    email:      clienteCFDI.email   || undefined,
    address: {
      zip: clienteCFDI.cp || '26000'
    }
  };

  let customer;
  try {
    // Buscar si ya existe el RFC
    const busqueda = await apiCall('GET', `/customers?search=${encodeURIComponent(clienteCFDI.rfc)}`);
    customer = busqueda.data?.[0];
  } catch (_) { /* no encontrado, crear */ }

  if (!customer) {
    customer = await apiCall('POST', '/customers', customerPayload);
  }

  // Construir items de la factura
  const items = (pedido.items || []).map(item => ({
    quantity: item.cantidad || 1,
    product: {
      description:  item.nombre,
      product_key:  CLAVE_PROD_ALIMENTOS,
      unit_key:     'H87',       // Pieza (SAT)
      price:        parseFloat(item.precio_unitario || 0),
      tax_included: true,        // precio ya incluye IVA
      taxes: [{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false }]
    }
  }));

  // Descuento a nivel factura si aplica
  const descuento = parseFloat(pedido.descuento || 0);

  const facturaPayload = {
    customer:        customer.id,
    items,
    use:             clienteCFDI.uso_cfdi || 'G03',
    payment_form:    mapFormaPago(pedido.forma_pago),
    payment_method:  'PUE',      // Pago en una sola exhibición
    ...(descuento > 0 && { global_information: undefined })
  };

  const factura = await apiCall('POST', '/invoices', facturaPayload);
  console.log(`[Facturapi] Factura creada: ${factura.id} — ${clienteCFDI.rfc} — $${pedido.total}`);
  return factura;
}

export async function enviarFacturaPorEmail(facturaId, email) {
  await apiCall('POST', `/invoices/${facturaId}/email`, { email });
  console.log(`[Facturapi] Factura ${facturaId} enviada a ${email}`);
}

export async function descargarFacturaPDF(facturaId) {
  if (!key()) throw new Error('FACTURAPI_KEY no configurada');
  const resp = await fetch(`${BASE}/invoices/${facturaId}/pdf`, {
    headers: { 'Authorization': `Bearer ${key()}` }
  });
  if (!resp.ok) throw new Error(`Facturapi PDF: ${resp.status}`);
  return resp.arrayBuffer();
}
