// «🧾 Factura» del tablero: liga y código QR de autofactura de una venta, para
// entregarla en el mostrador. Lo usan el admin y la caja (decisión de Mario,
// 21-oct). Solo pide la liga (POST /api/facturacion/pedidos/:folio/autofactura):
// no emite ni cobra. Al admin le ofrece además capturar los datos y facturar,
// con el modal «Generar factura» de siempre.
(function (global) {
  'use strict';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MENSAJES = {
    PEDIDO_NO_PAGADO: 'La venta aún no está pagada: la liga sale al cobrarla o entregarla.',
    PEDIDO_CANCELADO: 'La venta está cancelada; no se puede facturar.',
    PEDIDO_NO_ENCONTRADO: 'No encontramos esa venta.',
    TOTAL_CAMBIO: 'El total de la venta cambió; revísala antes de facturar.',
  };
  let abierto = null;

  function cerrar() {
    if (abierto) { abierto.remove(); abierto = null; }
  }

  // Número para wa.me: 10 dígitos de México con su 52, o ya con 52/521.
  function telefonoWa(t) {
    const d = String(t || '').replace(/\D/g, '');
    if (d.length === 10) return `52${d}`;
    return /^521?\d{10}$/.test(d) ? d : '';
  }

  // El portapapeles moderno exige HTTPS y foco; si se niega, se copia a la antigua.
  async function copiar(texto, input) {
    try {
      if (global.navigator?.clipboard?.writeText) { await global.navigator.clipboard.writeText(texto); return; }
    } catch { /* se intenta con execCommand */ }
    input.focus(); input.select();
    if (!global.document.execCommand('copy')) throw new Error('El navegador no permitió copiar la liga.');
  }

  async function abrir(folio, { apiFetch, svgQr, telefono = '', esAdmin = false, alFacturar = null } = {}) {
    cerrar();
    const doc = global.document;
    const capa = doc.createElement('div');
    capa.className = 'factura-mostrador';
    capa.setAttribute('role', 'dialog');
    capa.setAttribute('aria-modal', 'true');
    capa.setAttribute('aria-label', `Factura de la venta ${folio}`);
    capa.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:320;display:flex;align-items:center;justify-content:center;padding:16px;';
    capa.innerHTML = `<div style="background:#fff;border-radius:14px;max-width:360px;width:100%;max-height:92vh;overflow:auto;padding:18px;box-sizing:border-box;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.25);">
      <h3 style="margin:0 0 2px;font-size:1.05rem;">🧾 Factura</h3>
      <p style="margin:0 0 12px;color:#666;font-size:.85rem;">Venta ${esc(folio)}</p>
      <div data-fm-cuerpo style="min-height:80px;color:#666;font-size:.9rem;">Preparando la liga…</div>
      <button type="button" data-fm-cerrar style="margin-top:14px;width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;font-size:.9rem;">Cerrar</button>
    </div>`;
    capa.addEventListener('click', (e) => { if (e.target === capa || e.target.closest?.('[data-fm-cerrar]')) cerrar(); });
    doc.body.appendChild(capa);
    abierto = capa;
    const cuerpo = capa.querySelector('[data-fm-cuerpo]');

    let af;
    try {
      const r = await apiFetch(`/api/facturacion/pedidos/${encodeURIComponent(folio)}/autofactura`, { method: 'POST', body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.autofactura?.url) throw new Error(MENSAJES[d?.codigo] || d?.error || 'No se pudo preparar la liga de factura.');
      af = d.autofactura;
    } catch (e) {
      if (abierto === capa) cuerpo.innerHTML = `<p style="color:#b91c1c;">${esc(e.message)}</p>`;
      return;
    }
    if (abierto !== capa) return; // se cerró mientras cargaba

    const vence = af.expiresAt ? new Date(af.expiresAt).toLocaleDateString('es-MX', { timeZone: 'America/Matamoros' }) : '';
    const textoWa = `Para facturar tu consumo ${af.folio}, captura tus datos fiscales aquí: ${af.url}`;
    const facturada = af.estado === 'facturada';
    cuerpo.innerHTML = `
      ${facturada ? '<p style="color:#15803d;font-weight:700;margin:0 0 8px;">Esta venta ya está facturada.</p>' : ''}
      <div data-fm-qr style="width:200px;max-width:100%;margin:0 auto;">${svgQr(af.qr) || ''}</div>
      <p style="font-size:.8rem;margin:8px 0;">El cliente escanea el código o abre la liga para capturar sus datos fiscales.${vence ? ` Vigente hasta ${esc(vence)}.` : ''}</p>
      <input data-fm-url readonly value="${esc(af.url)}" aria-label="Liga de factura" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #e5e2da;border-radius:8px;font-size:.78rem;">
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:10px;">
        <button type="button" data-fm-copiar style="flex:1;min-width:120px;padding:9px;border:1px solid #ddd;border-radius:8px;background:#f9fafb;cursor:pointer;">📋 Copiar liga</button>
        <a data-fm-wa href="https://wa.me/${telefonoWa(telefono)}?text=${encodeURIComponent(textoWa)}" target="_blank" rel="noopener noreferrer" style="flex:1;min-width:120px;padding:9px;border:1px solid #bbf7d0;border-radius:8px;background:#f0fdf4;color:#15803d;text-decoration:none;">💬 WhatsApp</a>
      </div>
      ${esAdmin && !facturada && typeof alFacturar === 'function' ? '<button type="button" data-fm-facturar style="margin-top:8px;width:100%;padding:9px;border:1px solid #c7d2fe;border-radius:8px;background:#eef2ff;color:#3730a3;cursor:pointer;">Capturar datos y facturar</button>' : ''}
      <p data-fm-aviso role="status" style="font-size:.78rem;color:#15803d;min-height:1em;margin:8px 0 0;"></p>`;
    const aviso = cuerpo.querySelector('[data-fm-aviso]');
    cuerpo.querySelector('[data-fm-copiar]').addEventListener('click', async () => {
      try { await copiar(af.url, cuerpo.querySelector('[data-fm-url]')); aviso.style.color = '#15803d'; aviso.textContent = 'Liga copiada.'; }
      catch (e) { aviso.style.color = '#b91c1c'; aviso.textContent = e.message; }
    });
    cuerpo.querySelector('[data-fm-facturar]')?.addEventListener('click', () => { cerrar(); alFacturar(af.folio); });
  }

  global.XaborFacturaMostrador = Object.freeze({ abrir, cerrar, telefonoWa });
})(window);
