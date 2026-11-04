// ─── Meta Pixel de la tienda (Panel → Tienda en línea → Analítica) ─────────
//
// Archivo aparte de index.html por la misma razón que tienda-ga4.js: el panel
// es un solo <script> donde una función con nombre repetido pisa en silencio
// a la otra. Todo vive en esta IIFE y lo único global es
// `XaborMetaPixelTienda`. Botones por delegación de eventos, sin onclick en
// línea. Este editor NO carga el píxel: el panel nunca habla con Meta.
//
// Habla solo con /api/admin/tienda/meta-pixel (src/services/tiendaRutasCore.js,
// solo administradores); el servidor vuelve a validar el formato
// (src/services/tiendaMetaPixel.js).
(function () {
  const RE_ID = /^\d{15,16}$/;
  const E = { cont: null, id: null, slug: null };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function decir(t, color) {
    const el = document.getElementById('tmp-estado');
    if (el) { el.style.color = color || 'var(--color-text-secondary)'; el.textContent = t; }
  }

  function pintar() {
    const liga = E.slug ? `${location.origin}/t/${encodeURIComponent(E.slug)}` : null;
    E.cont.innerHTML = `
      <div class="tnd-card">
        <h3>Meta Pixel (Facebook e Instagram)</h3>
        <div class="sub">Mide visitas, carritos y ventas de tu tienda en línea en tu propio píxel de Meta, para tus
          anuncios de Facebook e Instagram. Si lo dejas vacío, tu tienda no carga nada de Meta.</div>
        ${E.id ? `<div class="tnd-aviso" style="background:var(--color-success-light);color:#047857;">✓ <div>Tu tienda está enviando datos al píxel <strong>${esc(E.id)}</strong>.</div></div>` : ''}
        <div class="tnd-campo">
          <label for="tmp-id">Meta Pixel ID</label>
          <input id="tmp-id" maxlength="16" inputmode="numeric" placeholder="15 o 16 dígitos" autocomplete="off" spellcheck="false"
            style="font-family:ui-monospace,Menlo,Consolas,monospace;" value="${esc(E.id || '')}">
          <div class="ayuda">En el Administrador de eventos de Meta: Orígenes de datos → tu píxel → el número de 15 o 16 dígitos que aparece como «Identificador».</div>
        </div>
        <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;">
          <button class="tnd-btn" data-acc="guardar">Guardar</button>
          ${E.id ? '<button class="tnd-btn sec" data-acc="quitar">Quitar</button>' : ''}
          <span id="tmp-estado" style="font-size:0.8rem;font-weight:700;"></span>
        </div>
      </div>
      <div class="tnd-card">
        <h3>Qué se envía a Meta</h3>
        <div class="sub" style="margin-bottom:6px;">Eventos estándar, en pesos (MXN) y con el nombre de la sucursal: ver la tienda
          (PageView), abrir un platillo (ViewContent), agregar al carrito (AddToCart), iniciar el pedido (InitiateCheckout) y la
          compra (Purchase) con su folio — solo cuando el pedido queda confirmado o pagado, y una sola vez.</div>
        <div class="sub" style="margin-bottom:${liga ? '12px' : '0'};">Nunca se envían nombre, teléfono, dirección, correo ni notas del cliente.
          En Meta, deja apagadas las «Coincidencias avanzadas automáticas» del píxel.</div>
        ${liga ? `<a class="tnd-btn sec" href="${esc(liga)}" target="_blank" rel="noopener" style="text-decoration:none;">Abrir mi tienda ↗</a>` : ''}
      </div>`;
  }

  async function guardar(valor) {
    const id = String(valor || '').trim();
    if (id && !RE_ID.test(id)) return decir('El Meta Pixel ID son 15 o 16 dígitos, sin letras ni espacios', 'var(--color-danger)');
    decir('Guardando…');
    try {
      const r = await apiFetch('/api/admin/tienda/meta-pixel', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metaPixelId: id || null }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo guardar');
      E.id = d.metaPixelId || null;
      pintar();
      decir(E.id ? '✓ Guardado' : '✓ Quitado: tu tienda ya no carga el Meta Pixel', 'var(--color-success)');
    } catch (e) {
      decir(e.message, 'var(--color-danger)');
    }
  }

  function alClic(e) {
    const b = e.target.closest('[data-acc]');
    if (!b || b.disabled) return;
    if (b.dataset.acc === 'guardar') return guardar(document.getElementById('tmp-id')?.value);
    if (b.dataset.acc === 'quitar') {
      if (!confirm('¿Quitar el Meta Pixel de tu tienda? Dejará de medir visitas y ventas para tus anuncios.')) return;
      return guardar('');
    }
  }

  async function abrir(cont) {
    if (!cont) return;
    if (E.cont !== cont) {
      E.cont = cont;
      cont.addEventListener('click', alClic);
      cont.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.target?.id === 'tmp-id') { e.preventDefault(); guardar(e.target.value); }
      });
    }
    cont.innerHTML = '<div class="tnd-card">Cargando…</div>';
    try {
      const r = await apiFetch('/api/admin/tienda/meta-pixel');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo cargar la configuración del Meta Pixel');
      E.id = d.metaPixelId || null;
      E.slug = d.slug || null;
      pintar();
    } catch (e) {
      cont.innerHTML = `<div class="tnd-aviso alerta">⚠️ <div>${esc(e.message)}</div></div>`;
    }
  }

  window.XaborMetaPixelTienda = { abrir };
})();
