// ─── Reportes › Ventas: «Lo que te diría un consejero» (Fase 1) ─────────────
//
// Plan aprobado por el dueño el 25-nov-2026. Arriba de Reportes › Ventas, unos
// pocos consejos con números exactos y, debajo, la tabla desplegable «Cuánto
// arrastra cada categoría». Los textos y los números los arma el servidor
// (src/services/reporteConsejero.js) con las MISMAS cuentas de Reportes ›
// Productos: aquí solo se pintan.
//
// Mira los últimos 28 días SIN contar hoy: no sigue el periodo de arriba de
// Reportes, y por eso se pide una sola vez (y otra vez al cambiar de sucursal
// o pasada media hora).
//
// Depende de las banderas `reportes_productos_v1` y `reportes_consejero_v1`:
// lo enciende reportes-productos.js (XaborConsejero.cargar) solo cuando el
// estado del negocio trae `consejero: true`. Apagado, este archivo no pinta ni
// pide nada. Lo único global es `XaborConsejero`.
(function () {
  const VIGENCIA_MS = 30 * 60 * 1000;
  const E = { datos: null, error: '', peticion: 0, sucursal: null, cargadoEn: 0, tablaAbierta: false };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 });
  const pct = (n) => `${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 1 })} %`;
  const pesos = (n) => (n === null || n === undefined ? '—' : `$${Math.round(Number(n)).toLocaleString('es-MX')}`);

  function estilos() {
    if ($('rc-estilos')) return;
    const s = document.createElement('style');
    s.id = 'rc-estilos';
    s.textContent = `
#ventas-consejero { margin-bottom:4px; }
.rc-consejos { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr)); gap:10px; }
.rc-consejo { background:#faf9f6; border:1px solid #efece5; border-left:4px solid var(--color-brand, #ea580c); border-radius:10px; padding:10px 12px; min-width:0; }
.rc-consejo .rc-tit { font-weight:800; font-size:0.9rem; margin-bottom:4px; overflow-wrap:anywhere; }
.rc-consejo p { margin:0; font-size:0.85rem; line-height:1.45; color:#333; overflow-wrap:anywhere; }
.rc-aviso { font-size:0.85rem; color:#555; background:#f8f7f4; border-radius:8px; padding:10px 12px; margin-bottom:8px; }
.rc-error { color:#b91c1c; font-size:0.85rem; }
.rc-tabla td:first-child { font-weight:700; }
.rc-tabla td.rc-junto { min-width:160px; color:#555; }
`;
    document.head.appendChild(s);
  }

  // El recuadro va arriba de las tarjetas de Ventas (lo primero que se ve).
  function contenedor() {
    let el = $('ventas-consejero');
    if (el) return el;
    const vista = $('vista-ventas');
    if (!vista) return null;
    el = document.createElement('section');
    el.id = 'ventas-consejero';
    el.setAttribute('aria-label', 'Lo que te diría un consejero');
    el.hidden = true;
    const tarjeta = $('pos-total-val');
    const rejilla = tarjeta && tarjeta.closest('.pos-card') ? tarjeta.closest('.pos-card').parentElement : null;
    const desglose = $('ventas-desglose');
    if (rejilla && rejilla.parentElement === vista) vista.insertBefore(el, rejilla);
    else if (desglose && desglose.parentElement === vista) vista.insertBefore(el, desglose);
    else vista.appendChild(el);
    el.addEventListener('toggle', (ev) => {
      if (ev.target && ev.target.matches && ev.target.matches('details[data-tabla-arrastre]')) E.tablaAbierta = ev.target.open;
    }, true);
    return el;
  }

  function ocultar() {
    E.peticion++;
    const el = $('ventas-consejero');
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  async function cargar({ activo = false, sucursal = 'actual' } = {}) {
    if (!activo) { ocultar(); return; }
    const el = contenedor();
    if (!el) return;
    estilos();
    el.hidden = false;
    const vigente = E.datos && E.sucursal === sucursal && Date.now() - E.cargadoEn < VIGENCIA_MS;
    if (vigente) { if (!el.innerHTML) pintar(); return; }
    E.sucursal = sucursal;
    const peticion = ++E.peticion;
    if (!E.datos) el.innerHTML = '<div class="rp-caja"><div class="rp-sub">Leyendo los últimos 28 días…</div></div>';
    else el.style.opacity = '0.6';
    let d = null, error = '';
    try {
      const r = await apiFetch(`/api/reportes/consejero?${new URLSearchParams({ sucursal })}`);
      d = await r.json().catch(() => null);
      if (!r.ok || !d || !Array.isArray(d.consejos)) {
        error = r.status === 403 && d && d.code === 'SUCURSAL_NO_PERMITIDA'
          ? 'El consejero no está encendido en esa sucursal.'
          : (d && d.error) || 'No se pudo cargar el consejero';
        d = null;
      }
    } catch {
      error = 'No se pudo cargar el consejero';
    }
    if (peticion !== E.peticion) return;
    el.style.opacity = '';
    E.datos = d; E.error = error; E.cargadoEn = d ? Date.now() : 0;
    pintar();
  }

  function filaTabla(f) {
    const junto = (f.con_categorias || []).map((x) => x.nombre).join(', ') || '—';
    return `<tr data-arrastre="${esc(f.clave)}">
      <td>${esc(f.nombre)}</td>
      <td class="n">${pct(f.pct_venta)}</td>
      <td class="n">${num(f.tickets)} <span class="rp-sub">· ${pct(f.pct_tickets)}</span></td>
      <td class="n">${pesos(f.dinero_tickets)} <span class="rp-sub">· ${pct(f.pct_dinero_tickets)}</span></td>
      <td class="n">${num(f.solo_tickets)} <span class="rp-sub">· ${pct(f.pct_solo)}</span></td>
      <td class="n">${pesos(f.ticket_con)}</td>
      <td class="n">${pesos(f.ticket_sin)}</td>
      <td class="rc-junto">${esc(junto)}</td>
    </tr>`;
  }

  function pintar() {
    const el = $('ventas-consejero');
    if (!el) return;
    const d = E.datos;
    const cab = (etiqueta) => `<div class="rp-titulo"><span>💡 Lo que te diría un consejero</span>${etiqueta ? `<span class="rp-sub" data-ventana>Últimos 28 días: ${esc(etiqueta)}</span>` : ''}</div>`;
    if (!d) {
      el.innerHTML = `<div class="rp-caja">${cab('')}<div class="rc-error">${esc(E.error || 'Sin datos')}</div></div>`;
      return;
    }
    const nombres = d.sucursal === 'todas' || d.sucursal === 'otra'
      ? (d.sucursales || []).filter((s) => (d.elegidas || []).includes(s.id)).map((s) => s.nombre) : [];
    const deQuien = nombres.length ? `<div class="rp-sub" style="margin:-4px 0 8px;">${esc(nombres.join(' + '))}</div>` : '';
    const aviso = d.aviso ? `<div class="rc-aviso" data-aviso="${esc(d.estado)}">${esc(d.aviso)}</div>` : '';
    const consejos = d.consejos.length
      ? `<div class="rc-consejos">${d.consejos.map((c) => `<article class="rc-consejo" data-consejo="${esc(c.tipo)}">
          <div class="rc-tit">${esc(c.titulo)}</div><p>${esc(c.texto)}</p></article>`).join('')}</div>`
      : '';
    const tabla = d.tabla && d.tabla.length
      ? `<details class="rp-detalle" data-tabla-arrastre${E.tablaAbierta ? ' open' : ''}><summary>Cuánto arrastra cada categoría</summary>
          <div class="rp-tabla-env"><table class="rp-tabla rc-tabla">
            <thead><tr><th>Categoría</th><th class="n">% de la venta</th><th class="n">Tickets que la llevan</th><th class="n">Dinero de esos tickets</th>
              <th class="n">Solo con ella</th><th class="n">Ticket con ella</th><th class="n">Ticket sin ella</th><th>Se acompaña con</th></tr></thead>
            <tbody>${d.tabla.map(filaTabla).join('')}</tbody></table></div>
          <div class="rp-nota">«% de la venta» es lo que vende la categoría por sí sola. «Dinero de esos tickets» es todo lo que dejaron los tickets que la llevan, con lo demás que se pidió.</div>
        </details>`
      : '';
    el.innerHTML = `<div class="rp-caja">${cab(d.ventana && d.ventana.etiqueta)}${deQuien}${aviso}${consejos}${tabla}
      <div class="rp-nota">Cuentas de los últimos 28 días, sin contar hoy: no cambian con el periodo de arriba. «El dinero» es la venta neta de los tickets, como en Ventas, y una mesa cuenta como un ticket.</div></div>`;
  }

  window.XaborConsejero = { cargar, ocultar };
})();
