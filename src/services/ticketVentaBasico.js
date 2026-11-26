// Ticket de venta propio del POS: no requiere facturación ni impresión Edge.
const esc = valor => String(valor ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pesos = n => new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(Number(n)||0);
export function ticketVentaHtml({negocio,folio,estado,datos,fecha,timeZone='America/Mexico_City',entrega=null}) {
  const pagado=datos.forma_pago && datos.forma_pago!=='por_cobrar';
  const items=Array.isArray(datos.items)?datos.items:[];
  const fechaLocal=new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone}).format(new Date(fecha));
  return `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>Ticket ${esc(folio)}</title>
  <style>*{box-sizing:border-box}body{font:15px system-ui,sans-serif;color:#181818;max-width:80mm;margin:32px auto;padding:16px}h1{font-size:22px}h2{font-size:18px;margin:0 0 12px}table{width:100%;border-collapse:collapse}td{padding:8px 0;vertical-align:top}td:last-child{text-align:right;white-space:nowrap}small{color:#555}hr{border:0;border-top:1px dashed #999}.total{font-size:22px;font-weight:bold;text-align:right}button,.boton{display:block;padding:12px;background:#c24f1a;color:white;border:0;border-radius:8px;width:100%;cursor:pointer;font:600 15px system-ui;text-align:center;text-decoration:none}button:disabled{opacity:.6;cursor:default}.entrega{margin-top:24px;padding-top:20px;border-top:1px solid #ddd}.whatsapp{background:#176b50}.entrega p{line-height:1.5}.entrega label{display:block;font-weight:600;margin:20px 0 6px}.entrega input{width:100%;padding:12px;font:16px system-ui;border:1px solid #aaa;border-radius:8px;margin-bottom:10px}.mensaje{min-height:24px;font-size:14px;overflow-wrap:anywhere}.mensaje.error{color:#a01d1d}:focus-visible{outline:3px solid #176b50;outline-offset:3px}@media print{body{margin:0;padding:0}button,.ayuda,.entrega{display:none}}</style>
  </head><body><h1>${esc(negocio)}</h1><p>Ticket ${esc(folio)}<br><small>${esc(fechaLocal)}</small></p>
  <p>${estado==='cancelado'?'CANCELADO':pagado?'Venta registrada':'Orden por cobrar'}</p><hr><table><tbody>
  ${items.map(i=>`<tr><td>${esc(i.cantidad)} × ${esc(i.nombre??i.producto??'Producto')}</td><td>${pesos(Number(i.cantidad)*Number(i.precio_unitario??i.precio??0))}</td></tr>`).join('')}
  </tbody></table><hr><p>Descuentos: ${pesos(datos.descuento)}<br>Envío: ${pesos(datos.costo_envio)}</p>
  <p class="total">Total ${pesos(datos.total)}</p><p>Forma de pago: ${esc(datos.forma_pago||'Pendiente')}</p>
  <p><small>Comprobante de venta. No es una factura fiscal.</small></p>
  <button id="ticket-imprimir" type="button">Imprimir o guardar PDF</button>
  <p class="ayuda"><small>Usa una impresora instalada y compatible con tu navegador. Ajusta el papel y los márgenes en el diálogo de impresión.</small></p>
  ${entrega ? `<section class="entrega" aria-labelledby="entrega-titulo">
    <h2 id="entrega-titulo">Entrega este ticket</h2>
    <a id="ticket-whatsapp" class="boton whatsapp" href="${esc(entrega.whatsappUrl)}" target="_blank" rel="noopener noreferrer">Compartir por WhatsApp</a>
    <p><small>Se abrirá WhatsApp con el enlace preparado. Tú eliges el contacto y envías el mensaje.</small></p>
    <form id="ticket-correo" method="post" action="${esc('/api/tickets-venta/'+encodeURIComponent(folio)+'/correo')}" data-endpoint="${esc('/api/tickets-venta/'+encodeURIComponent(folio)+'/correo')}" data-token="${esc(entrega.token)}" data-negocio="${esc(entrega.negocioId)}">
      <label for="ticket-email">Correo del cliente</label>
      <input id="ticket-email" name="email" type="email" maxlength="254" autocomplete="off" placeholder="cliente@ejemplo.com" required>
      <button id="ticket-enviar" type="submit"${entrega.correoDisponible ? '' : ' disabled'}>Enviar por correo</button>
      ${entrega.correoDisponible ? '' : '<p><small>El envío por correo no está disponible en este momento. Puedes compartir por WhatsApp.</small></p>'}
      <p id="ticket-mensaje" class="mensaje" role="status" aria-live="polite"></p>
    </form>
    <p><small>El enlace es válido durante 30 días. Quien lo reciba podrá consultar únicamente este ticket, sin entrar a tu negocio.</small></p>
  </section>` : ''}
  <script src="/public/ticket-venta.js?v=644cc9c8" defer></script></body></html>`;
}
