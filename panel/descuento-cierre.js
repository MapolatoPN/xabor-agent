// ─── Descuento a quien escribió con el negocio cerrado (Tienda → Promociones) ──
//
// Pedido de Mario (11-nov-2026): «deberías poner un botón, nada en código».
// Una tarjeta con «Encender» / «Apagar» arriba de la lista de promociones.
//
// Archivo aparte de index.html por la misma razón que tienda-ga4.js: el panel
// es un solo <script> donde una función con nombre repetido pisa en silencio a
// la otra. Todo vive en esta IIFE y lo único global es `XaborDescuentoCierre`.
// Botones por delegación de eventos, sin onclick en línea.
//
// Habla solo con /api/admin/descuento-cierre (src/services/descuentoTrasCierreRutas.js,
// solo administradores). Para el operador la ruta responde 403 y la tarjeta
// no aparece. Encender o apagar no manda nada: los envíos los hace el job.
(function () {
  const E = { cont: null, d: null, ocupado: false, pendiente: null };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function fecha(iso) {
    const f = iso ? new Date(iso) : null;
    if (!f || isNaN(f)) return '';
    return `${f.getDate()} de ${MESES[f.getMonth()]}`;
  }
  const cuanto = p => (p.tipo === 'monto_fijo' ? `$${p.valor}` : `${p.valor} %`);

  function decir(t, color) {
    const el = document.getElementById('tdc-estado');
    if (el) { el.style.color = color || 'var(--color-text-secondary)'; el.textContent = t; }
  }

  function pintar() {
    const d = E.d;
    const p = d.promo;
    const detalle = d.encendido && p
      ? `Código <strong>${esc(p.codigo)}</strong> · ${esc(cuanto(p))} · ${p.limitePorCliente ? `${esc(p.limitePorCliente)} uso por cliente` : 'sin límite por cliente'} · vale ${esc(d.diasVigencia)} días desde que se manda`
      : `Al encenderlo se usa el código <strong>${esc(d.codigo)}</strong>${p ? ` (ya existe: ${esc(cuanto(p))})` : ` con ${esc(d.porcentajeNuevo)} %`}, un uso por cliente, solo en la tienda en línea.`;
    const env = d.enviados || {};
    const enviados = env.aceptados || env.fallidos
      ? `Enviados: <strong>${esc(env.aceptados)}</strong>${env.fallidos ? ` · no salieron: ${esc(env.fallidos)}` : ''}${env.ultimo ? ` · último el ${esc(fecha(env.ultimo))}` : ''}`
      : 'Todavía no se ha mandado a nadie.';
    let aviso = '';
    if (d.encendido && d.job?.problema) {
      aviso = `<div class="tnd-aviso alerta">⚠️ <div><strong>Encendido, pero no está mandando:</strong> ${esc(d.job.problema)}</div></div>`;
    } else if (!d.encendido && !d.tiendaPublicada) {
      aviso = '<div class="tnd-aviso alerta">⚠️ <div>Para encenderlo, primero publica tu tienda en línea: el código solo se puede usar ahí.</div></div>';
    } else if (!d.encendido && !d.horarioPropio) {
      aviso = '<div class="tnd-aviso alerta">⚠️ <div>Para encenderlo, primero guarda tu horario de atención en Configuración.</div></div>';
    }
    E.cont.innerHTML = `
      <div class="tnd-card" style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
          <h3 style="margin:0;">💬 Descuento a quien escribió con el negocio cerrado</h3>
          <span class="tnd-chip ${d.encendido ? 'publicada' : 'borrador'}" style="font-size:0.7rem;">${d.encendido ? 'Encendido' : 'Apagado'}</span>
        </div>
        <div class="sub" style="margin:6px 0 8px;">Si alguien te escribe por WhatsApp en tu horario de siempre un día que estuviste
          cerrado (por ejemplo, el domingo), al abrir le mandamos un código de descuento para tu tienda en línea. El
          mensaje dice hasta cuándo vale. Cada cliente lo recibe una sola vez.</div>
        <div class="sub" style="margin:0 0 4px;">${detalle}</div>
        <div class="sub" style="margin:0 0 8px;">${enviados}</div>
        ${aviso}
        <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:10px;">
          ${d.encendido
            ? '<button class="tnd-btn sec" data-acc="apagar">Apagar</button>'
            : `<button class="tnd-btn" data-acc="encender"${d.tiendaPublicada && d.horarioPropio ? '' : ' disabled'}>Encender</button>`}
          <span id="tdc-estado" style="font-size:0.8rem;font-weight:700;"></span>
        </div>
      </div>`;
    if (E.pendiente) { decir(E.pendiente, 'var(--color-success)'); E.pendiente = null; }
  }

  async function cambiar(encendido) {
    if (E.ocupado) return;
    E.ocupado = true;
    decir(encendido ? 'Encendiendo…' : 'Apagando…');
    E.cont.querySelectorAll('[data-acc]').forEach(b => { b.disabled = true; });
    try {
      const r = await apiFetch('/api/admin/descuento-cierre', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encendido }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo guardar');
      E.d = d.estado;
      const porMandar = E.d.job?.porMandar || 0;
      E.pendiente = encendido
        ? (porMandar ? `✓ Encendido. Hay ${porMandar} por mandar: salen en el siguiente minuto.` : '✓ Encendido')
        : '✓ Apagado. A quien ya lo recibió le sigue valiendo hasta la fecha que se le dijo.';
      // Encender puede crear o reactivar la promoción: se recarga la sección
      // para que la lista de abajo la muestre (y esta tarjeta, con el aviso).
      if (typeof window.tndPromociones === 'function') window.tndPromociones();
      else pintar();
    } catch (e) {
      E.cont.querySelectorAll('[data-acc]').forEach(b => { b.disabled = false; });
      decir(e.message, 'var(--color-danger)');
    } finally {
      E.ocupado = false;
    }
  }

  function alClic(e) {
    const b = e.target.closest('[data-acc]');
    if (!b || b.disabled) return;
    if (b.dataset.acc === 'encender') {
      if (!confirm(`¿Encender el descuento? Desde ahora, al abrir, a quien te escribió con el negocio cerrado le llegará por WhatsApp el código ${E.d?.codigo || ''}.`)) return;
      return cambiar(true);
    }
    if (b.dataset.acc === 'apagar') {
      if (!confirm('¿Apagar el descuento? Ya no se le mandará a nadie más. A quien ya lo recibió le sigue valiendo hasta la fecha que se le dijo.')) return;
      return cambiar(false);
    }
  }

  async function abrir(cont) {
    if (!cont) return;
    if (E.cont !== cont) {
      E.cont = cont;
      cont.addEventListener('click', alClic);
    }
    cont.innerHTML = '';
    try {
      const r = await apiFetch('/api/admin/descuento-cierre');
      // El operador no lo administra: sin tarjeta, sin aviso.
      if (r.status === 401 || r.status === 403) return;
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo leer el descuento por cierre');
      E.d = d;
      pintar();
    } catch (e) {
      cont.innerHTML = `<div class="tnd-aviso alerta" style="margin-bottom:14px;">⚠️ <div>${esc(e.message)}</div></div>`;
    }
  }

  window.XaborDescuentoCierre = { abrir };
})();
