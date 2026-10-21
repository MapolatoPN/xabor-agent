// Cancelación de CFDI en el centro de Facturación (solo admin; la pestaña ya es
// de admin y el servidor lo exige). Pide la cancelación al SAT vía
// POST /api/admin/facturacion/facturas/:id/cancelar con el motivo del SAT y,
// para 01/04, el CFDI que la sustituye. El estado (cancelada, en proceso,
// rechazada...) lo lee de GET /api/admin/facturacion/cancelaciones.
(function (global) {
  'use strict';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cod = (v) => encodeURIComponent(String(v ?? '')).replace(/'/g, '%27');
  const MOTIVOS = [
    ['02', '02 · Errores sin relación (no hay CFDI que la sustituya)'],
    ['01', '01 · Errores con relación (ya emitiste el CFDI correcto)'],
    ['03', '03 · No se llevó a cabo la operación'],
    ['04', '04 · Operación nominativa en una factura global'],
  ];
  const ESTADOS = {
    cancelada: ['Cancelada', '#6b7280', '#f3f4f6'],
    en_proceso: ['Cancelación en proceso', '#92400e', '#fffbeb'],
    solicitando: ['Cancelación en proceso', '#92400e', '#fffbeb'],
    rechazada: ['Cancelación rechazada', '#b91c1c', '#fef2f2'],
    expirada: ['Cancelación vencida', '#b91c1c', '#fef2f2'],
  };
  let abierto = null;

  /** Cancelaciones del negocio por factura_id. Un fallo no rompe el listado. */
  async function cargar(apiFetch) {
    try {
      const r = await apiFetch('/api/admin/facturacion/cancelaciones', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      return new Map((r.ok && Array.isArray(d.cancelaciones) ? d.cancelaciones : []).map((c) => [c.factura_id, c]));
    } catch { return new Map(); }
  }

  /** [etiqueta, color, fondo] si la cancelación cambia lo que se muestra. */
  function estado(c) { return c ? ESTADOS[c.estado] || null : null; }

  /** Botón de la fila (HTML) o ''. */
  function accion(doc, c) {
    const timbrada = doc.factura_id && ['facturado', 'facturada', 'cancelada'].includes(doc.estado);
    if (!timbrada) return '';
    const id = cod(doc.factura_id), ref = cod(doc.tipo === 'venta' ? doc.folio : doc.referencia);
    if (c && ['en_proceso', 'solicitando'].includes(c.estado)) {
      return `<button onclick="sincronizarCancelacionCfdiUI('${id}',this)" style="border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:7px;padding:5px 8px;">Actualizar cancelación</button>`;
    }
    if (c?.estado === 'cancelada' || doc.estado === 'cancelada') return '';
    return `<button onclick="abrirCancelarCfdiUI('${id}','${ref}')" title="${c ? esc(`Intento anterior: ${c.error_detalle || c.estado}`) : 'Pide al SAT la cancelación de este CFDI'}" style="border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:7px;padding:5px 8px;">Cancelar CFDI</button>`;
  }

  function cerrar() { if (abierto) { abierto.remove(); abierto = null; } }

  function abrir(facturaId, { apiFetch, referencia = '', alTerminar = null } = {}) {
    cerrar();
    const doc = global.document;
    const capa = doc.createElement('div');
    capa.className = 'cancelar-cfdi';
    capa.setAttribute('role', 'dialog');
    capa.setAttribute('aria-modal', 'true');
    capa.setAttribute('aria-label', 'Cancelar CFDI');
    capa.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:330;display:flex;align-items:center;justify-content:center;padding:16px;';
    capa.innerHTML = `<form style="background:#fff;border-radius:14px;max-width:420px;width:100%;max-height:92vh;overflow:auto;padding:18px;box-sizing:border-box;box-shadow:0 10px 30px rgba(0,0,0,.25);">
      <h3 style="margin:0 0 4px;font-size:1.05rem;">Cancelar CFDI</h3>
      <p style="margin:0 0 12px;color:#666;font-size:.82rem;">${esc(referencia)}</p>
      <label style="display:block;font-size:.8rem;font-weight:600;color:#555;">Motivo del SAT
        <select data-cc-motivo style="display:block;width:100%;margin-top:4px;padding:9px;border:1px solid #e5e2da;border-radius:8px;font-size:.85rem;">
          ${MOTIVOS.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}
        </select></label>
      <label data-cc-bloque-sust style="display:none;margin-top:10px;font-size:.8rem;font-weight:600;color:#555;"><span data-cc-texto-sust>UUID del CFDI que la sustituye</span>
        <input data-cc-sust autocomplete="off" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:9px;border:1px solid #e5e2da;border-radius:8px;font-size:.82rem;"></label>
      <p style="font-size:.76rem;color:#92400e;background:#fffbeb;border-radius:8px;padding:8px;margin:12px 0 0;">La cancelación se pide al SAT y no se puede deshacer. Puede requerir que el cliente la acepte; mientras tanto el CFDI sigue vigente.</p>
      <p data-cc-aviso role="status" style="font-size:.8rem;min-height:1em;margin:10px 0 0;"></p>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button type="button" data-cc-cerrar style="flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;">Cerrar</button>
        <button type="submit" data-cc-enviar style="flex:1;padding:10px;border:1px solid #fecaca;border-radius:8px;background:#b91c1c;color:#fff;font-weight:700;cursor:pointer;">Solicitar cancelación</button>
      </div></form>`;
    const q = (s) => capa.querySelector(s);
    const ajustar = () => {
      const m = q('[data-cc-motivo]').value;
      q('[data-cc-bloque-sust]').style.display = m === '01' || m === '04' ? 'block' : 'none';
      q('[data-cc-texto-sust]').textContent = m === '04' ? 'UUID de la factura global' : 'UUID del CFDI que la sustituye (registrado en Xabor)';
    };
    q('[data-cc-motivo]').addEventListener('change', ajustar);
    capa.addEventListener('click', (e) => { if (e.target === capa || e.target.closest?.('[data-cc-cerrar]')) cerrar(); });
    q('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const motivo = q('[data-cc-motivo]').value;
      const sustitucion = q('[data-cc-sust]').value.trim();
      const aviso = q('[data-cc-aviso]');
      if ((motivo === '01' || motivo === '04') && !sustitucion) { aviso.style.color = '#b91c1c'; aviso.textContent = 'Indica el CFDI que la sustituye.'; return; }
      const boton = q('[data-cc-enviar]');
      boton.disabled = true; boton.textContent = 'Solicitando…';
      try {
        const r = await apiFetch(`/api/admin/facturacion/facturas/${encodeURIComponent(facturaId)}/cancelar`, {
          method: 'POST', body: JSON.stringify({ motivo, ...(sustitucion ? { sustitucion } : {}) }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'No se pudo solicitar la cancelación.');
        const c = d.cancelacion || {};
        aviso.style.color = c.estado === 'cancelada' ? '#15803d' : '#92400e';
        aviso.textContent = c.estado === 'cancelada' ? 'CFDI cancelado ante el SAT.'
          : 'Cancelación solicitada; el SAT o el cliente aún deben aceptarla. Xabor revisa su estado cada 5 minutos.';
        boton.textContent = 'Solicitada';
        if (typeof alTerminar === 'function') alTerminar(c);
      } catch (err) {
        aviso.style.color = '#b91c1c'; aviso.textContent = err.message;
        boton.disabled = false; boton.textContent = 'Solicitar cancelación';
      }
    });
    doc.body.appendChild(capa);
    abierto = capa;
    ajustar();
  }

  async function sincronizar(facturaId, { apiFetch }) {
    const r = await apiFetch(`/api/admin/facturacion/facturas/${encodeURIComponent(facturaId)}/cancelacion/sincronizar`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'No se pudo consultar la cancelación.');
    return d.cancelacion;
  }

  global.XaborCancelacionCfdi = Object.freeze({ cargar, estado, accion, abrir, cerrar, sincronizar, MOTIVOS });
})(window);
