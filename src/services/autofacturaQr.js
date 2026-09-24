// QR de la liga pública de autofactura.
//
// Se genera una sola vez al preparar el snapshot de impresión. El payload
// lleva la matriz (no una imagen dependiente de red), así que el Edge puede
// imprimirla aunque el ticket llegue por la cola local sin internet.
import QRCode from 'qrcode';

const NIVELES = new Set(['L', 'M', 'Q', 'H']);

export function generarMatrizQr(texto, { nivel = 'M' } = {}) {
  const valor = String(texto || '').trim();
  if (!valor) return null;
  const errorCorrectionLevel = NIVELES.has(String(nivel).toUpperCase()) ? String(nivel).toUpperCase() : 'M';
  const qr = QRCode.create(valor, { errorCorrectionLevel });
  const size = Number(qr.modules?.size);
  const data = Array.from(qr.modules?.data || [], (bit) => bit ? 1 : 0);
  if (!Number.isInteger(size) || size < 21 || size > 177 || data.length !== size * size) return null;
  return { size, data };
}

export function matrizQrValida(qr) {
  const size = Number(qr?.size);
  return Number.isInteger(size) && size >= 21 && size <= 177
    && Array.isArray(qr?.data) && qr.data.length === size * size
    && qr.data.every((bit) => bit === 0 || bit === 1);
}
