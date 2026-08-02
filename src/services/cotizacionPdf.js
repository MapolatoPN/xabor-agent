/**
 * cotizacionPdf.js — Genera el PDF de una cotización con la marca del
 * negocio (logo, color, datos fiscales/comerciales), vía Puppeteer
 * (HTML/CSS -> PDF). Los datos de marca vienen de `configuracion`
 * (mismo patrón clave/valor ya usado por el resto del panel, sin tabla
 * nueva): logo_base64, color_primario, terminos_cotizacion_default,
 * vigencia_dias_default, anticipo_porcentaje_default -- además de las
 * claves ya existentes nombre/rfc/direccion/telefono/ciudad.
 *
 * No usa datos de Alora como valores globales: todo sale de
 * `configuracion` scoped por negocio_id; si un negocio no configuró
 * logo/color, el PDF se genera igual con valores neutros por defecto.
 */
// Carga perezosa (no import estático): puppeteer solo se necesita cuando
// realmente se genera un PDF. Importarlo a nivel de módulo alargaría el
// arranque de src/server.js para TODAS las requests, incluso las que nunca
// tocan cotizaciones -- server.js es un archivo caliente, se evita cualquier
// costo de arranque que no sea estrictamente necesario.
let _puppeteer;
async function obtenerPuppeteer() {
  if (!_puppeteer) _puppeteer = (await import('puppeteer')).default;
  return _puppeteer;
}

function escaparHtml(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatoMoneda(n) {
  return `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function construirHtml(cotizacion, negocioConfig) {
  const colorPrimario = negocioConfig.color_primario || '#1c1c1c';
  const logo = negocioConfig.logo_base64
    ? `<img src="${negocioConfig.logo_base64}" style="max-height:64px;max-width:200px;object-fit:contain;">`
    : `<div style="font-size:1.4rem;font-weight:800;">${escaparHtml(negocioConfig.nombre || 'Cotización')}</div>`;

  const filasItems = (cotizacion.items || []).map(it => {
    const importe = Number(it.cantidad) * Number(it.precio_unitario) - Number(it.descuento || 0);
    return `
      <tr>
        <td>${escaparHtml(it.descripcion)}</td>
        <td style="text-align:center;">${Number(it.cantidad)}</td>
        <td style="text-align:right;">${formatoMoneda(it.precio_unitario)}</td>
        <td style="text-align:right;">${it.descuento ? formatoMoneda(it.descuento) : '—'}</td>
        <td style="text-align:right;">${formatoMoneda(importe)}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8"><style>
    body { font-family: Arial, Helvetica, sans-serif; color: #1c1c1c; padding: 32px; font-size: 13px; }
    .encabezado { display:flex; justify-content:space-between; align-items:flex-start; border-bottom: 3px solid ${colorPrimario}; padding-bottom: 16px; margin-bottom: 20px; }
    .folio { text-align:right; }
    .folio h1 { margin:0; font-size:1.1rem; color: ${colorPrimario}; }
    table { width:100%; border-collapse: collapse; margin-top: 16px; }
    th { background: ${colorPrimario}; color:#fff; text-align:left; padding:8px; font-size:0.8rem; }
    td { padding:8px; border-bottom: 1px solid #eee; font-size:0.85rem; }
    .totales { margin-top: 16px; width: 260px; margin-left: auto; }
    .totales div { display:flex; justify-content:space-between; padding: 3px 0; }
    .total-final { font-weight:800; font-size:1.05rem; border-top: 2px solid ${colorPrimario}; padding-top:6px !important; }
    .footer { margin-top: 28px; font-size: 0.78rem; color: #555; white-space: pre-wrap; }
  </style></head>
  <body>
    <div class="encabezado">
      <div>
        ${logo}
        <div style="margin-top:6px;font-size:0.8rem;color:#555;">
          ${escaparHtml(negocioConfig.direccion || '')}<br>
          ${escaparHtml(negocioConfig.telefono || '')} ${negocioConfig.rfc ? '· RFC ' + escaparHtml(negocioConfig.rfc) : ''}
        </div>
      </div>
      <div class="folio">
        <h1>Cotización ${escaparHtml(cotizacion.folio)}</h1>
        <div>Versión ${cotizacion.version}</div>
        <div>Fecha: ${new Date(cotizacion.created_at).toLocaleDateString('es-MX')}</div>
        ${cotizacion.vigencia_hasta ? `<div>Vigente hasta: ${new Date(cotizacion.vigencia_hasta).toLocaleDateString('es-MX')}</div>` : ''}
      </div>
    </div>

    ${cotizacion.evento_nombre ? `<div><strong>Evento:</strong> ${escaparHtml(cotizacion.evento_nombre)}</div>` : ''}
    ${cotizacion.fecha_evento ? `<div><strong>Fecha del evento:</strong> ${new Date(cotizacion.fecha_evento).toLocaleDateString('es-MX')}</div>` : ''}
    ${cotizacion.lugar ? `<div><strong>Lugar:</strong> ${escaparHtml(cotizacion.lugar)}</div>` : ''}
    ${cotizacion.cantidad_personas ? `<div><strong>Personas:</strong> ${cotizacion.cantidad_personas}</div>` : ''}

    <table>
      <thead><tr><th>Descripción</th><th>Cant.</th><th>Precio unit.</th><th>Descuento</th><th>Importe</th></tr></thead>
      <tbody>${filasItems}</tbody>
    </table>

    <div class="totales">
      <div><span>Subtotal</span><span>${formatoMoneda(cotizacion.subtotal)}</span></div>
      <div><span>Impuestos</span><span>${formatoMoneda(cotizacion.impuestos)}</span></div>
      <div><span>Descuentos</span><span>-${formatoMoneda(cotizacion.descuentos)}</span></div>
      <div class="total-final"><span>Total</span><span>${formatoMoneda(cotizacion.total)}</span></div>
      ${cotizacion.anticipo_requerido ? `<div><span>Anticipo requerido</span><span>${formatoMoneda(cotizacion.anticipo_requerido)}</span></div>` : ''}
    </div>

    ${cotizacion.notas ? `<div class="footer"><strong>Notas:</strong> ${escaparHtml(cotizacion.notas)}</div>` : ''}
    ${cotizacion.terminos ? `<div class="footer"><strong>Términos y condiciones:</strong>\n${escaparHtml(cotizacion.terminos)}</div>` : ''}
  </body></html>`;
}

const TIMEOUT_GENERACION_MS = Number(process.env.COTIZACION_PDF_TIMEOUT_MS) || 20000;

// Bajo contención real de recursos (CPU/memoria compartidos) un lanzamiento
// de Chromium puede quedarse colgado indefinidamente en vez de fallar --
// mejor un 500 claro y rápido que una request colgada para siempre.
export async function generarPdfCotizacion(cotizacion, negocioConfig) {
  const html = construirHtml(cotizacion, negocioConfig);
  const puppeteer = await obtenerPuppeteer();
  let browser;
  const lanzamiento = puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    try {
      browser = await Promise.race([
        lanzamiento,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout al iniciar Chromium para generar el PDF')), TIMEOUT_GENERACION_MS)),
      ]);
    } catch (e) {
      // El timeout ganó la carrera -- si el lanzamiento real igual resuelve
      // más tarde, se cierra para no dejar un proceso de Chromium huérfano.
      lanzamiento.then(b => b.close().catch(() => {})).catch(() => {});
      throw e;
    }
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: TIMEOUT_GENERACION_MS });
    const bytes = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20px', bottom: '20px' }, timeout: TIMEOUT_GENERACION_MS });
    // page.pdf() devuelve Uint8Array (no Buffer) -- Express.res.send()
    // trata un Uint8Array plano como objeto JSON en vez de binario, así
    // que se envuelve explícitamente antes de devolverlo a cualquier
    // llamador (guardarArchivo, res.send, etc.).
    return Buffer.from(bytes);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
