// ─── Clientes: aviso de promociones de la tienda ────────────────────────────
//
// Saneamiento de Clientes, fase 2 (21-nov-2026). El texto que el cliente lee
// junto al botón de pedir en la tienda en línea («Al pedir aceptas recibir
// promociones de …; puedes darte de baja cuando quieras»). Pedir con él a la
// vista lo deja como «aceptó»; nunca deshace una baja.
//
// Archivo aparte de index.html por la misma razón que clientes-saneamiento.js:
// el panel es un solo <script> donde una función con nombre repetido pisa en
// silencio a la otra. Todo vive en esta IIFE y lo único global es
// `XaborClientesConsentimiento`. Botones por delegación ([data-cpr-acc]), sin
// onclick en línea.
//
// Habla solo con /api/admin/clientes/aviso-promociones (solo administradores;
// el negocio sale de la sesión: src/services/avisoPromocionesRutas.js).
(function () {
  const E = { ocupado: false, datos: null };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);
  const fecha = v => v ? new Date(v).toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const URL_AVISO = '/api/admin/clientes/aviso-promociones';

  async function pedir(url, opciones) {
    const r = await apiFetch(url, opciones);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'No se pudo completar');
    return d;
  }

  function modal() {
    let m = $('cpr-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'cpr-modal';
    m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;align-items:center;justify-content:center;';
    m.innerHTML = `<div style="background:#fff;border-radius:16px;padding:22px;max-width:560px;width:92%;max-height:88vh;overflow-y:auto;position:relative;box-sizing:border-box;">
      <button type="button" data-cpr-acc="cerrar" aria-label="Cerrar" style="position:absolute;top:12px;right:12px;border:none;background:none;font-size:1.3rem;cursor:pointer;color:#888;">✕</button>
      <div style="font-size:1.05rem;font-weight:800;margin-bottom:6px;padding-right:28px;">📣 Aviso de promociones</div>
      <div style="font-size:0.8rem;color:#666;margin-bottom:12px;">Lo lee el cliente en la tienda en línea, debajo del botón de pedir.
        Quien pide con el aviso a la vista queda como <strong>«aceptó»</strong> promociones por WhatsApp; a quien ya se dio de baja
        no se le cambia nada. Las campañas van a todos menos a quien se dio de baja.</div>
      <div id="cpr-cuerpo"><div style="color:#aaa;text-align:center;padding:16px;">Cargando…</div></div>
    </div>`;
    m.addEventListener('click', e => { if (e.target === m) m.style.display = 'none'; });
    document.body.appendChild(m);
    return m;
  }

  function decir(t, color) {
    const el = $('cpr-estado');
    if (el) { el.style.color = color || '#888'; el.textContent = t || ''; }
  }

  function pintar(d) {
    E.datos = d;
    const v = d.vigente;
    const texto = v ? v.texto : d.porOmision;
    const encendido = v ? v.enTienda : true;
    const historial = (d.historial || []).length ? `<div style="margin-top:14px;">
        <div style="font-size:0.72rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Versiones</div>
        ${d.historial.map((h, i) => `<div style="font-size:0.75rem;color:#666;padding:5px 0;border-top:1px solid #f0ede8;">
          <span style="color:#999;">${esc(fecha(h.fecha))} · ${h.creadoPor === 'sistema' ? 'texto por omisión' : 'administrador'}${h.enTienda ? '' : ' · apagado'}${i === 0 ? ' · <strong>vigente</strong>' : ''}</span>
          <div>${esc(h.texto)}</div></div>`).join('')}</div>` : '';
    $('cpr-cuerpo').innerHTML = `
      <label style="display:flex;align-items:center;gap:8px;font-size:0.85rem;margin-bottom:10px;cursor:pointer;">
        <input id="cpr-en-tienda" type="checkbox" ${encendido ? 'checked' : ''}> Mostrar el aviso en la tienda en línea</label>
      <textarea id="cpr-texto" maxlength="${Number(d.maxTexto) || 300}" rows="3"
        style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #e5e2da;border-radius:8px;font-size:0.85rem;font-family:inherit;resize:vertical;">${esc(texto)}</textarea>
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:0.72rem;color:#999;margin-top:4px;">
        <span id="cpr-cuenta"></span>
        <button type="button" data-cpr-acc="omision" style="border:none;background:none;color:#FF6B35;font-size:0.75rem;cursor:pointer;padding:0;">Usar el texto por omisión</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;">
        <button type="button" data-cpr-acc="guardar"
          style="padding:7px 16px;border:none;border-radius:8px;background:#FF6B35;color:#fff;font-weight:700;font-size:0.85rem;cursor:pointer;">Guardar</button>
        <span id="cpr-estado" style="font-size:0.8rem;font-weight:700;"></span>
      </div>
      <div style="font-size:0.75rem;color:#888;margin-top:10px;">${Number(d.aceptacionesAlPedir || 0).toLocaleString('es-MX')} cliente(s) han aceptado al pedir en la tienda.</div>
      ${historial}`;
    contar();
  }

  function contar() {
    const t = $('cpr-texto'), c = $('cpr-cuenta');
    if (t && c) c.textContent = `${t.value.length} / ${Number(E.datos?.maxTexto) || 300}`;
  }

  async function abrir() {
    modal().style.display = 'flex';
    $('cpr-cuerpo').innerHTML = '<div style="color:#aaa;text-align:center;padding:16px;">Cargando…</div>';
    try { pintar(await pedir(URL_AVISO)); } catch (e) {
      $('cpr-cuerpo').innerHTML = `<div style="color:#ef4444;font-size:0.85rem;">${esc(e.message)}</div>`;
    }
  }

  async function guardar() {
    const texto = ($('cpr-texto')?.value || '').trim();
    const enTienda = $('cpr-en-tienda')?.checked === true;
    if (!texto) { decir('Escribe el aviso.', '#ef4444'); return; }
    decir('Guardando…');
    try {
      const d = await pedir(URL_AVISO, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto, enTienda }) });
      pintar(d);
      decir(d.cambio ? '✓ Guardado. La tienda lo muestra desde ya.' : 'Sin cambios: ya era el aviso vigente.', '#16a34a');
    } catch (e) { decir(e.message, '#ef4444'); }
  }

  document.addEventListener('input', e => { if (e.target && e.target.id === 'cpr-texto') contar(); });

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-cpr-acc]');
    if (!b || b.disabled) return;
    const acc = b.dataset.cprAcc;
    if (acc === 'cerrar') { modal().style.display = 'none'; return; }
    if (acc === 'omision') { if ($('cpr-texto') && E.datos) { $('cpr-texto').value = E.datos.porOmision; contar(); } return; }
    if (E.ocupado) return;
    E.ocupado = true;
    try {
      if (acc === 'aviso') await abrir();
      if (acc === 'guardar') await guardar();
    } finally { E.ocupado = false; }
  });

  window.XaborClientesConsentimiento = { abrir };
})();
