import { createHash } from 'node:crypto';
import { pool } from './database.js';
import { validarImagenReal, comprimirImagen } from './imagenes.js';
import { guardarArchivo, eliminarArchivo } from './almacenamiento.js';
import { extraerTicketConIA } from './ticketComprasIA.js';
import { crearBorradorDesdeTicket, CompraOperativaError } from './comprasOperativas.js';

export async function ingresarTicketWhatsapp(negocioId, buffer, actor, extraer = extraerTicketConIA) {
  const validacion = await validarImagenReal(buffer);
  if (!validacion.valido) throw new CompraOperativaError('Envía una foto JPG, PNG o WEBP legible y de menor tamaño.', 'TICKET_INVALIDO');
  const foto = await comprimirImagen(buffer, validacion.mime);
  const checksum = createHash('sha256').update(foto.buffer).digest('hex');
  const repetida = await pool.query("SELECT id FROM compras_operativas WHERE negocio_id=$1 AND ticket_checksum=$2 AND estado<>'cancelada'", [negocioId, checksum]);
  if (repetida.rows.length) return { id: repetida.rows[0].id, repetida: true };
  const datos = await extraer(foto.buffer, foto.mime);
  if (datos.moneda && !['MXN','MX$','$','PESO','PESOS','PESOS MEXICANOS'].includes(datos.moneda.toUpperCase()))
    throw new CompraOperativaError('Este ticket tiene otra moneda. Revísalo en Compras.', 'TICKET_MONEDA_NO_SOPORTADA');
  // La misma foto reenviada ya se detecta por checksum; también revisamos folio,
  // proveedor, fecha y total para detectar otra fotografía del mismo ticket.
  if (datos.numero_ticket && datos.proveedor && datos.fecha && datos.total != null) {
    const {rows} = await pool.query(`SELECT id FROM compras_operativas WHERE negocio_id=$1 AND estado<>'cancelada'
      AND numero_ticket=$2 AND lower(proveedor)=lower($3) AND fecha=$4 AND total=$5`,
    [negocioId, datos.numero_ticket, datos.proveedor, datos.fecha, datos.total]);
    if (rows.length) return {id: rows[0].id, repetida: true};
  }
  let key = await guardarArchivo(foto.buffer, {negocioId,extension:foto.extension,mimeType:foto.mime,categoria:'documento'});
  try {
    const compra = await crearBorradorDesdeTicket(negocioId, datos,
      {storageKey:key,mimeType:foto.mime,checksum,nombre:'ticket-whatsapp'},actor);
    key = null;
    return {id:compra.id,repetida:false};
  } finally { if (key) await eliminarArchivo(key).catch(()=>{}); }
}
