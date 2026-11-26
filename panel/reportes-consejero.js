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
//
// Versión 2 (corrección del dueño, 25-nov-2026; bandera `reportes_consejero_v2`):
// el estado trae `consejero_v2: true`, reportes-productos.js manda el periodo
// de arriba (`rango`) y el servidor contesta `version: 2`. Entonces se pinta
// con pintarV2: la etiqueta del periodo junto al título, qué cambió contra el
// periodo anterior, una acción y qué revisar en 2 semanas, y la tabla con el
// lift y «Otras». Sin `version: 2` todo sigue como en la versión 1.
(function () {
  const VIGENCIA_MS = 30 * 60 * 1000;
  const E = { datos: null, error: '', peticion: 0, sucursal: null, llave: null, cargadoEn: 0, tablaAbierta: false };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Como esc, y el «%» no se separa de su número al cambiar de renglón («23 % más»).
  const escPegado = (s) => esc(s).replace(/(\d) %/g, '$1&nbsp;%');
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
.rc-periodo { display:inline-block; font-size:0.82rem; font-weight:700; color:#9a3412; background:#fff1e6; border:1px solid #fed7aa; border-radius:999px; padding:2px 10px; }
.rc-cambio { display:flex; flex-wrap:wrap; gap:4px 10px; margin-top:8px; font-size:0.8rem; color:#555; }
.rc-cambio .rc-sube { color:#15803d; font-weight:700; } .rc-cambio .rc-baja { color:#b91c1c; font-weight:700; }
.rc-accion { margin-top:8px; font-size:0.85rem; font-weight:700; color:#1a1a1a; }
.rc-revisar { margin-top:4px; font-size:0.8rem; color:#555; }
.rc-tabla-env { overflow-x:auto; scrollbar-width:thin; scrollbar-color:#bfb9ac #f4f2ee; padding-bottom:4px; }
.rc-tabla-env::-webkit-scrollbar { height:8px; }
.rc-tabla-env::-webkit-scrollbar-thumb { background:#bfb9ac; border-radius:4px; }
.rc-tabla-env::-webkit-scrollbar-track { background:#f4f2ee; }
.rc-tabla2 th { white-space:normal; vertical-align:bottom; }
.rc-tabla2 td.rc-junto { min-width:140px; color:#555; white-space:normal; }
.rc-tabla2 tr.rc-otras td { color:#666; }
.rc-desliza { font-size:0.78rem; color:#9a3412; margin:4px 0; }
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

  // `rango` ({ desde, hasta }) solo llega con la versión 2: sin él, la
  // petición y la llave son las de la versión 1.
  async function cargar({ activo = false, sucursal = 'actual', rango = null } = {}) {
    if (!activo) { ocultar(); return; }
    const el = contenedor();
    if (!el) return;
    estilos();
    el.hidden = false;
    const conRango = rango && rango.desde && rango.hasta;
    const llave = `${sucursal}|${conRango ? `${rango.desde}|${rango.hasta}` : ''}`;
    const vigente = E.datos && E.llave === llave && Date.now() - E.cargadoEn < VIGENCIA_MS;
    if (vigente) { if (!el.innerHTML) pintar(); return; }
    E.sucursal = sucursal; E.llave = llave;
    const peticion = ++E.peticion;
    if (!E.datos) el.innerHTML = `<div class="rp-caja"><div class="rp-sub">${conRango ? 'Leyendo el periodo…' : 'Leyendo los últimos 28 días…'}</div></div>`;
    else el.style.opacity = '0.6';
    let d = null, error = '';
    try {
      const params = { sucursal };
      if (conRango) { params.desde = rango.desde; params.hasta = rango.hasta; }
      const r = await apiFetch(`/api/reportes/consejero?${new URLSearchParams(params)}`);
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
    if (d && d.version === 2) { pintarV2(el, d); return; }
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

  // ─── Versión 2 ─────────────────────────────────────────────────────────
  const signo = (p) => {
    if (p === null || p === undefined) return 'sin dato';
    const x = Math.round(Number(p) * 10) / 10;
    return `${x > 0 ? '+' : x < 0 ? '−' : ''}${pct(Math.abs(x))}`;
  };
  // ▲/▼ además del color: el sentido no depende solo del color.
  function chip(nombre, v, esDinero) {
    if (!v) return '';
    const clase = v.pct > 0 ? 'rc-sube' : v.pct < 0 ? 'rc-baja' : '';
    const flecha = v.pct > 0 ? '▲ ' : v.pct < 0 ? '▼ ' : '';
    const valores = esDinero ? `${pesos(v.anterior)} → ${pesos(v.actual)}` : `${num(v.anterior)} → ${num(v.actual)}`;
    return `<span data-cambio-de="${esc(nombre)}">${esc(v.etiqueta || nombre)}: <span class="${clase}">${flecha}${escPegado(signo(v.pct))}</span> <span class="rp-sub">(${esc(valores)})</span></span>`;
  }
  function tarjetaV2(c) {
    const cm = c.cambio || {};
    const r = c.revisar || {};
    return `<article class="rc-consejo" data-consejo="${esc(c.tipo)}">
      <div class="rc-tit">${escPegado(c.titulo)}</div><p>${escPegado(c.texto)}</p>
      <div class="rc-cambio" data-cambio>${chip('venta', cm.venta, true)}${chip('tickets', cm.tickets, false)}${chip('promedio', cm.promedio, true)}</div>
      <div class="rc-accion" data-accion>👉 ${esc(c.accion)}</div>
      <div class="rc-revisar" data-revisar>📅 Revisa el ${esc(r.etiqueta)}: ${escPegado(r.numero)}. Hoy: ${escPegado(r.valor)}${r.meta ? `; ${esc(r.meta)}` : ''}.</div>
    </article>`;
  }
  function filaTablaV2(f) {
    const junto = (f.junto || []).map((x) => `${x.nombre} ×${Number(x.lift).toLocaleString('es-MX', { maximumFractionDigits: 1 })}`).join(', ');
    const cambio = f.cambio_venta_pct === null || f.cambio_venta_pct === undefined ? '—' : signo(f.cambio_venta_pct);
    return `<tr data-arrastre="${esc(f.clave)}">
      <td>${esc(f.nombre)}</td>
      <td class="n">${pct(f.pct_venta)}</td>
      <td class="n">${esc(cambio)}</td>
      <td class="n">${num(f.tickets)} <span class="rp-sub">· ${pct(f.pct_tickets)}</span></td>
      <td class="n">${pesos(f.dinero_tickets)} <span class="rp-sub">· ${pct(f.pct_dinero_tickets)}</span></td>
      <td class="n">${num(f.solo_tickets)} <span class="rp-sub">· ${pct(f.pct_solo)}</span></td>
      <td class="rc-junto">${esc(junto)}</td>
    </tr>`;
  }
  function filaOtras(o) {
    return `<tr data-arrastre="otras" class="rc-otras">
      <td>Otras <div class="rp-sub" style="font-weight:400;">${esc((o.categorias || []).join(', '))}</div></td>
      <td class="n">${pct(o.pct_venta)}</td>
      <td class="n">—</td>
      <td class="n">${num(o.tickets)} <span class="rp-sub">· ${pct(o.pct_tickets)}</span></td>
      <td class="n">${pesos(o.dinero_tickets)} <span class="rp-sub">· ${pct(o.pct_dinero_tickets)}</span></td>
      <td class="n">—</td>
      <td class="rc-junto"></td>
    </tr>`;
  }
  // La tabla tiene desplazamiento a lo ancho; si no cabe, se dice.
  function revisarDesliza() {
    const el = $('ventas-consejero');
    if (!el) return;
    const env = el.querySelector('.rc-tabla-env');
    const aviso = el.querySelector('[data-desliza]');
    if (!env || !aviso) return;
    aviso.hidden = !(env.clientWidth > 0 && env.scrollWidth > env.clientWidth + 1);
  }
  function pintarV2(el, d) {
    const p = d.periodo || {};
    const etiqueta = p.origen === 'periodo' ? `Periodo: ${p.etiqueta}` : `Últimos 28 días: ${p.etiqueta}`;
    const cab = `<div class="rp-titulo"><span>💡 Lo que te diría un consejero</span><span class="rc-periodo" data-periodo>${esc(etiqueta)}</span></div>`;
    const contra = d.anterior && d.anterior.etiqueta ? `<div class="rp-sub" data-contra style="margin:-4px 0 8px;">Comparado con ${esc(d.anterior.etiqueta)}</div>` : '';
    const corto = p.motivo === 'corto'
      ? '<div class="rc-aviso" data-periodo-corto>El periodo de arriba tiene menos de 14 días: aquí uso los últimos 28, sin contar hoy.</div>' : '';
    const nombres = d.sucursal === 'todas' || d.sucursal === 'otra'
      ? (d.sucursales || []).filter((s) => (d.elegidas || []).includes(s.id)).map((s) => s.nombre) : [];
    const deQuien = nombres.length ? `<div class="rp-sub" data-sucursales style="margin:-4px 0 8px;">${esc(nombres.join(' + '))}</div>` : '';
    const aviso = d.aviso ? `<div class="rc-aviso" data-aviso="${esc(d.estado)}">${esc(d.aviso)}</div>` : '';
    const consejos = d.consejos.length ? `<div class="rc-consejos">${d.consejos.map(tarjetaV2).join('')}</div>` : '';
    const filas = (d.tabla || []).map(filaTablaV2).join('') + (d.otras ? filaOtras(d.otras) : '');
    const tabla = filas
      ? `<details class="rp-detalle" data-tabla-arrastre${E.tablaAbierta ? ' open' : ''}><summary>Cuánto arrastra cada categoría</summary>
          <div class="rc-desliza" data-desliza hidden>La tabla sigue a la derecha: deslízala para ver todas las columnas →</div>
          <div class="rp-tabla-env rc-tabla-env"><table class="rp-tabla rc-tabla rc-tabla2">
            <thead><tr><th>Categoría</th><th class="n">% de la venta</th><th class="n">Cambio de su venta</th><th class="n">Tickets que la llevan</th>
              <th class="n">Dinero de esos tickets</th><th class="n">Va sola</th><th>Se acompaña con (más de lo normal)</th></tr></thead>
            <tbody>${filas}</tbody></table></div>
          <div class="rp-nota">«% de la venta» es lo que vende la categoría por sí sola. «Dinero de esos tickets» es todo lo que dejaron los tickets que la llevan, con lo demás que se pidió.
            «Se acompaña con» muestra lo que aparece en sus tickets al menos 1.3 veces más que en todos (y en al menos 30 tickets); los extras no cuentan, porque van con cualquier platillo. Vacía: nada se pide con ella más de lo normal.
            Las categorías con menos del 1 % de la venta van juntas en «Otras».</div>
        </details>`
      : '';
    const notas = (d.notas || []).map((n) => `<div class="rp-nota" data-nota>${esc(n)}</div>`).join('');
    el.innerHTML = `<div class="rp-caja">${cab}${contra}${corto}${deQuien}${aviso}${consejos}${tabla}${notas}</div>`;
    revisarDesliza();
  }
  window.addEventListener('resize', revisarDesliza);
  document.addEventListener('toggle', (ev) => {
    if (ev.target && ev.target.matches && ev.target.matches('#ventas-consejero details[data-tabla-arrastre]')) revisarDesliza();
  }, true);

  window.XaborConsejero = { cargar, ocultar };
})();
