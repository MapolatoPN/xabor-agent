import { fileTypeFromBuffer } from 'file-type';

// Rechaza formatos fuera del contrato ANTES de invocar un detector general.
// Un límite de bytes no protege de un bucle sobre un archivo muy pequeño.
const firma = (buffer, hex, offset = 0) => buffer.length >= offset + hex.length / 2
  && buffer.subarray(offset, offset + hex.length / 2).equals(Buffer.from(hex, 'hex'));

export async function tipoDeArchivoPermitido(buffer, categoria) {
  if (!Buffer.isBuffer(buffer)) return null;
  const candidato = categoria === 'pdf' ? firma(buffer, '255044462d')
    : categoria === 'imagen' && (firma(buffer, 'ffd8ff') || firma(buffer, '89504e470d0a1a0a')
      || (firma(buffer, '52494646') && firma(buffer, '57454250', 8)));
  if (!candidato) return null;
  try {
    const tipo = await fileTypeFromBuffer(buffer);
    const permitidos = categoria === 'pdf' ? ['application/pdf'] : ['image/jpeg','image/png','image/webp'];
    return permitidos.includes(tipo?.mime) ? tipo : null;
  } catch {
    return null; // Un archivo truncado no es un error de servidor.
  }
}
