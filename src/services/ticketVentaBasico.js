// Ticket de venta propio del POS: no requiere facturación ni impresión Edge.
const esc = valor => String(valor ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pesos = n => new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(Number(n)||0);
export function ticketVentaHtml({negocio,folio,estado,datos,fecha,timeZone='America/Mexico_City'}) {
  const pagado=datos.forma_pago && datos.forma_pago!=='por_cobrar';
  const items=Array.isArray(datos.items)?datos.items:[];
  const fechaLocal=new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone}).format(new Date(fecha));
  return `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer"><title>Ticket ${esc(folio)}</title>
  <style>body{font:15px system-ui,sans-serif;color:#181818;max-width:80mm;margin:32px auto;padding:16px}h1{font-size:22px}table{width:100%;border-collapse:collapse}td{padding:8px 0;vertical-align:top}td:last-child{text-align:right;white-space:nowrap}small{color:#555}hr{border:0;border-top:1px dashed #999}.total{font-size:22px;font-weight:bold;text-align:right}button{padding:12px;background:#ff6b35;color:white;border:0;border-radius:8px;width:100%;cursor:pointer}@media print{body{margin:0;padding:0}button,.ayuda{display:none}}</style>
  </head><body><h1>${esc(negocio)}</h1><p>Ticket ${esc(folio)}<br><small>${esc(fechaLocal)}</small></p>
  <p>${estado==='cancelado'?'CANCELADO':pagado?'Venta registrada':'Orden por cobrar'}</p><hr><table><tbody>
  ${items.map(i=>`<tr><td>${esc(i.cantidad)} × ${esc(i.nombre)}</td><td>${pesos(Number(i.cantidad)*Number(i.precio_unitario??i.precio??0))}</td></tr>`).join('')}
  </tbody></table><hr><p>Descuentos: ${pesos(datos.descuento)}<br>Envío: ${pesos(datos.costo_envio)}</p>
  <p class="total">Total ${pesos(datos.total)}</p><p>Forma de pago: ${esc(datos.forma_pago||'Pendiente')}</p>
  <p><small>Comprobante de venta. No es una factura fiscal.</small></p>
  <button onclick="window.print()">Imprimir o guardar PDF</button>
  <p class="ayuda"><small>Usa una impresora instalada y compatible con tu navegador. Ajusta el papel y los márgenes en el diálogo de impresión.</small></p></body></html>`;
}
