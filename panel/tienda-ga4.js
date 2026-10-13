// ─── Google Analytics 4 de la tienda (Panel → Tienda → Analítica) ──────────
//
// Archivo aparte de index.html por la misma razón que tienda-banner.js: el
// panel es un solo <script> donde una función con nombre repetido pisa en
// silencio a la otra. Todo vive en esta IIFE y lo único global es
// `XaborGa4Tienda`. Botones por delegación de eventos, sin onclick en línea.
//
// Habla solo con /api/admin/tienda/analytics (src/services/tiendaRutasCore.js,
// solo administradores); el servidor vuelve a validar el formato
// (src/services/tiendaAnalytics.js).
(function () {
  const RE_ID = /^G-[A-Z0-9]+$/;
  const E = { cont: null, id: null, slug: null };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function decir(t, color) {
    const el = document.getElementById('tga-estado');
    if (el) { el.style.color = color || 'var(--color-text-secondary)'; el.textContent = t; }
  }

  function pintar() {
    const liga = E.slug ? `${location.origin}/t/${encodeURIComponent(E.slug)}?ga4_debug=1` : null;
    E.cont.innerHTML = `
      <div class="tnd-card">
        <h3>Google Analytics 4</h3>
        <div class="sub">Mide visitas, carritos y ventas de tu tienda en línea en tu propia cuenta de
          Google Analytics. Si lo dejas vacío, tu tienda no carga nada de Google.</div>
        ${E.id ? `<div class="tnd-aviso" style="background:var(--color-success-light);color:#047857;">✓ <div>Tu tienda está enviando datos a <strong>${esc(E.id)}</strong>.</div></div>` : ''}
        <div class="tnd-campo">
          <label for="tga-id">ID de medición</label>
          <input id="tga-id" maxlength="32" placeholder="G-XXXXXXXXXX" autocomplete="off" spellcheck="false"
            style="text-transform:uppercase;font-family:ui-monospace,Menlo,Consolas,monospace;" value="${esc(E.id || '')}">
          <div class="ayuda">En Google Analytics: Administrar → Flujos de datos → tu sitio web → «ID de medición». Empieza con G-.</div>
        </div>
        <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;">
          <button class="tnd-btn" data-acc="guardar">Guardar</button>
          ${E.id ? '<button class="tnd-btn sec" data-acc="quitar">Quitar</button>' : ''}
          <span id="tga-estado" style="font-size:0.8rem;font-weight:700;"></span>
        </div>
      </div>
      <div class="tnd-card">
        <h3>Qué se envía</h3>
        <div class="sub" style="margin-bottom:6px;">Eventos de comercio electrónico de GA4, en pesos (MXN): ver el menú y
          cada producto, agregar o quitar del carrito (con sus opciones), abrir el carrito, iniciar el pedido,
          elegir entrega y forma de pago, y la compra con su folio — solo cuando el pedido queda confirmado o pagado.</div>
        <div class="sub" style="margin-bottom:6px;">Nunca se envían nombre, teléfono, dirección, correo ni notas del cliente.</div>
        <div class="sub" style="margin-bottom:${liga ? '12px' : '0'};">La visita se conserva entre mapolato.com y xabor.mx (medición entre dominios).</div>
        ${liga ? `<a class="tnd-btn sec" href="${esc(liga)}" target="_blank" rel="noopener" style="text-decoration:none;">Abrir mi tienda en modo prueba (DebugView) ↗</a>` : ''}
      </div>`;
  }

  async function guardar(valor) {
    const id = String(valor || '').trim().toUpperCase();
    if (id && !RE_ID.test(id)) return decir('El ID debe verse así: G-XXXXXXXXXX', 'var(--color-danger)');
    decir('Guardando…');
    try {
      const r = await apiFetch('/api/admin/tienda/analytics', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ga4MeasurementId: id || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo guardar');
      E.id = d.ga4MeasurementId || null;
      pintar();
      decir(E.id ? '✓ Guardado' : '✓ Quitado: tu tienda ya no carga Google Analytics', 'var(--color-success)');
    } catch (e) {
      decir(e.message, 'var(--color-danger)');
    }
  }

  function alClic(e) {
    const b = e.target.closest('[data-acc]');
    if (!b || b.disabled) return;
    if (b.dataset.acc === 'guardar') return guardar(document.getElementById('tga-id')?.value);
    if (b.dataset.acc === 'quitar') {
      if (!confirm('¿Quitar Google Analytics de tu tienda? Dejará de medir visitas y ventas.')) return;
      return guardar('');
    }
  }

  async function abrir(cont) {
    if (E.cont !== cont) {
      E.cont = cont;
      cont.addEventListener('click', alClic);
      cont.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target?.id === 'tga-id') { e.preventDefault(); guardar(e.target.value); }
      });
    }
    cont.innerHTML = '<div class="tnd-card">Cargando…</div>';
    try {
      const r = await apiFetch('/api/admin/tienda/analytics');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo cargar la configuración de Analytics');
      E.id = d.ga4MeasurementId || null;
      E.slug = d.slug || null;
      pintar();
    } catch (e) {
      cont.innerHTML = `<div class="tnd-aviso alerta">⚠️ <div>${esc(e.message)}</div></div>`;
    }
  }

  window.XaborGa4Tienda = { abrir };
})();
