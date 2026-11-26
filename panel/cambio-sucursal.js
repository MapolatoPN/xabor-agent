// Cambio de sucursal en la misma sesión (21-nov-2026, pedido de Mario).
//
// Quien pertenece a varias sucursales ve en la cabecera un botón con la
// sucursal actual («🏪 Obispado ▾»). Al elegir otra, el servidor cambia la
// sesión (POST /api/auth/cambiar-sucursal) y el panel se recarga entero: así
// no queda nada de la sucursal anterior (pedidos, WebSocket, caché, POS).
// Superadmin aparece en el mismo menú, también con una sola sucursal. Esta
// entrada solo navega: el servidor conserva la exigencia del segundo factor.
//
// La sesión es UNA cookie por navegador. Si hay otras pestañas del panel
// abiertas en este navegador, al cambiar quedarían mostrando una sucursal y
// hablando con otra. Por eso cada panel anuncia al cargar con qué sucursal
// quedó, y el que tenga otra se recarga (BroadcastChannel, con localStorage de
// respaldo). Al volver a una pestaña también se revisa. El candado definitivo
// es del servidor: apiFetch manda X-Xabor-Negocio y una petición de una
// pestaña vieja recibe 409 SUCURSAL_CAMBIADA (ver services/cambioSucursal.js).
(function (global) {
  'use strict';

  const CANAL = 'xabor-sesion';
  const CLAVE_LOCAL = 'xabor_sesion_negocio';
  const CABECERA = 'X-Xabor-Negocio';
  let negocioCargado = null;
  let recargando = false;
  let canal = null;
  let ultimaRevision = 0;
  let hayTrabajoSinGuardar = () => false;

  function recargar() {
    if (recargando) return;
    recargando = true;
    try { global.location.reload(); } catch (e) { /* sin ventana: pruebas */ }
  }

  // ─── Entre pestañas ─────────────────────────────────────────────────────
  function anunciar(negocioId) {
    const msg = { tipo: 'negocio', negocioId, t: Date.now() };
    try { if (canal) canal.postMessage(msg); } catch (e) {}
    try { global.localStorage.setItem(CLAVE_LOCAL, JSON.stringify(msg)); } catch (e) {}
  }

  function otraSucursal(msg) {
    return !!(msg && msg.tipo === 'negocio' && typeof msg.negocioId === 'string'
      && negocioCargado && msg.negocioId !== negocioCargado);
  }

  function escuchar() {
    try {
      canal = new global.BroadcastChannel(CANAL);
      canal.onmessage = (ev) => { if (otraSucursal(ev.data)) recargar(); };
    } catch (e) { canal = null; }
    global.addEventListener('storage', (ev) => {
      if (ev.key !== CLAVE_LOCAL || !ev.newValue) return;
      try { if (otraSucursal(JSON.parse(ev.newValue))) recargar(); } catch (e) {}
    });
    // Una pestaña congelada o dormida pudo perderse el aviso: al volver a
    // ella se pregunta al servidor con qué sucursal está la sesión.
    global.document.addEventListener('visibilitychange', () => {
      if (global.document.visibilityState === 'visible') revisarSesion();
    });
    global.addEventListener('focus', revisarSesion);
  }

  async function revisarSesion() {
    if (!negocioCargado || recargando || Date.now() - ultimaRevision < 3000) return;
    ultimaRevision = Date.now();
    try {
      const r = await global.fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!r.ok) return; // sin sesión: el panel ya sabe mandar al login
      const d = await r.json();
      if (d && d.negocioId && d.negocioId !== negocioCargado) recargar();
    } catch (e) { /* sin red: se revisa en la siguiente vuelta */ }
  }

  // ─── Botón y menú ───────────────────────────────────────────────────────
  function estilos() {
    if (global.document.getElementById('estilos-cambio-sucursal')) return;
    const st = global.document.createElement('style');
    st.id = 'estilos-cambio-sucursal';
    st.textContent = `
#btn-sucursal { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; font-weight: 600; color: var(--color-text-primary, #1A1D23); }
#btn-sucursal[hidden] { display: none; }
#btn-sucursal .suc-nombre { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#menu-sucursal { position: fixed; z-index: 10000; min-width: 230px; max-width: calc(100vw - 24px);
  background: var(--color-surface, #fff); border: 1px solid var(--color-border-strong, #DEE2E6);
  border-radius: var(--radius-md, 8px); box-shadow: 0 10px 30px rgba(0,0,0,.14); padding: 6px; }
#menu-sucursal[hidden] { display: none; }
#menu-sucursal .ms-titulo { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
  color: var(--color-text-muted, #9CA3AF); padding: 6px 10px 4px; }
#menu-sucursal button { display: flex; width: 100%; align-items: center; gap: 10px; text-align: left; border: 0;
  background: transparent; border-radius: 6px; padding: 10px; font: inherit; font-size: .9rem; cursor: pointer;
  color: var(--color-text-primary, #1A1D23); min-height: 44px; }
#menu-sucursal button:hover:not(:disabled) { background: var(--color-surface-2, #F1F3F5); }
#menu-sucursal button:disabled { cursor: default; }
#menu-sucursal button .ms-marca { width: 16px; color: var(--color-brand, #FF6B35); font-weight: 800; }
#menu-sucursal button .ms-detalle { display: block; font-size: .74rem; color: var(--color-text-secondary, #6B7280); font-weight: 400; }
#menu-sucursal button[aria-checked="true"] { background: var(--color-brand-light, #FFF4EF); font-weight: 700; }
#menu-sucursal .ms-plataforma { border-top: 1px solid var(--color-border-strong, #DEE2E6); margin-top: 6px; padding-top: 10px; }
#menu-sucursal .ms-superadmin { font-weight: 700; }
#menu-sucursal .ms-error { color: var(--color-danger, #EF4444); font-size: .8rem; padding: 4px 10px 6px; }
#menu-sucursal .ms-error:empty { display: none; }
/* Celular: la cabecera no cabe con todo. El botón se encoge (el nombre se corta
   con «…»), sin ícono ni flecha, y el estado de conexión queda solo como el punto de
   color (verde/rojo) para que «Salir» no se salga de la pantalla. */
@media (max-width: 640px) {
  #btn-sucursal { max-width: 128px; min-width: 0; flex-shrink: 1; padding: 0 10px; gap: 4px; }
  #btn-sucursal .suc-flecha, #btn-sucursal .suc-icono { display: none; }
  body.con-cambio-sucursal #label-ws { display: none; }
}
@media print { #btn-sucursal, #menu-sucursal { display: none !important; } }`;
    global.document.head.appendChild(st);
  }

  const rolTexto = (rol) => (rol === 'admin' ? 'Administrador' : 'Operador');

  function pintarBoton(sucursales, puedeAbrirSuperadmin) {
    const doc = global.document;
    const btn = doc.getElementById('btn-sucursal');
    const actual = sucursales.find((s) => s.actual);
    if (!btn || !actual) return;
    estilos();
    btn.textContent = '';
    const icono = doc.createElement('span'); icono.className = 'suc-icono'; icono.setAttribute('aria-hidden', 'true'); icono.textContent = '🏪';
    const nombre = doc.createElement('span'); nombre.className = 'suc-nombre'; nombre.textContent = actual.etiqueta;
    const flecha = doc.createElement('span'); flecha.className = 'suc-flecha'; flecha.setAttribute('aria-hidden', 'true'); flecha.textContent = '▾';
    btn.append(icono, nombre, flecha);
    const opciones = puedeAbrirSuperadmin ? 'Sucursales y Superadmin' : 'Cambiar de sucursal';
    btn.title = `Sucursal: ${actual.nombre}. ${opciones}`;
    btn.setAttribute('aria-label', `Sucursal actual: ${actual.nombre}. ${opciones}`);
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.hidden = false;
    doc.body.classList.add('con-cambio-sucursal');

    let menu = doc.getElementById('menu-sucursal');
    if (!menu) {
      menu = doc.createElement('div');
      menu.id = 'menu-sucursal';
      menu.setAttribute('role', 'menu');
      menu.hidden = true;
      doc.body.appendChild(menu);
    }
    menu.textContent = '';
    const titulo = doc.createElement('div'); titulo.className = 'ms-titulo'; titulo.textContent = 'Cambiar de sucursal';
    menu.appendChild(titulo);
    for (const s of sucursales) {
      const item = doc.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', s.actual ? 'true' : 'false');
      item.dataset.negocioId = s.negocioId;
      const marca = doc.createElement('span'); marca.className = 'ms-marca'; marca.setAttribute('aria-hidden', 'true'); marca.textContent = s.actual ? '✓' : '';
      const texto = doc.createElement('span');
      texto.textContent = s.nombre;
      const detalle = doc.createElement('span'); detalle.className = 'ms-detalle';
      detalle.textContent = s.actual ? `${rolTexto(s.rol)} · estás aquí` : rolTexto(s.rol);
      texto.appendChild(detalle);
      item.append(marca, texto);
      if (s.actual) item.disabled = true;
      else item.addEventListener('click', () => cambiar(s, menu));
      menu.appendChild(item);
    }
    if (puedeAbrirSuperadmin) {
      const seccion = doc.createElement('div');
      seccion.className = 'ms-titulo ms-plataforma';
      seccion.textContent = 'Administración de Xabor';
      menu.appendChild(seccion);
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'ms-superadmin';
      item.setAttribute('role', 'menuitem');
      const marca = doc.createElement('span');
      marca.className = 'ms-marca';
      marca.setAttribute('aria-hidden', 'true');
      marca.textContent = '↗';
      const texto = doc.createElement('span');
      texto.textContent = 'Superadmin';
      const detalle = doc.createElement('span');
      detalle.className = 'ms-detalle';
      detalle.textContent = 'Negocios y plataforma';
      texto.appendChild(detalle);
      item.append(marca, texto);
      item.addEventListener('click', () => {
        let pendiente = false;
        try { pendiente = !!hayTrabajoSinGuardar(); } catch (e) {}
        if (pendiente && !global.confirm('Tienes un pedido a medio capturar. Si abres Superadmin se pierde. ¿Continuar?')) return;
        global.location.href = '/superadmin';
      });
      menu.appendChild(item);
    }
    const error = doc.createElement('div'); error.className = 'ms-error'; error.setAttribute('role', 'alert');
    menu.appendChild(error);

    btn.onclick = (ev) => { ev.stopPropagation(); if (menu.hidden) abrir(btn, menu); else cerrar(btn, menu); };
    doc.addEventListener('click', (ev) => { if (!menu.hidden && !menu.contains(ev.target)) cerrar(btn, menu); });
    doc.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !menu.hidden) { cerrar(btn, menu); btn.focus(); } });
    global.addEventListener('resize', () => { if (!menu.hidden) colocar(btn, menu); });
  }

  function colocar(btn, menu) {
    const r = btn.getBoundingClientRect();
    const ancho = menu.offsetWidth || 240;
    const izq = Math.max(12, Math.min(r.right - ancho, global.innerWidth - ancho - 12));
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(izq)}px`;
  }

  function abrir(btn, menu) {
    menu.querySelector('.ms-error').textContent = '';
    menu.hidden = false;
    colocar(btn, menu);
    btn.setAttribute('aria-expanded', 'true');
    const primera = menu.querySelector('button:not(:disabled)');
    if (primera) primera.focus();
  }

  function cerrar(btn, menu) {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  async function cambiar(sucursal, menu) {
    const error = menu.querySelector('.ms-error');
    error.textContent = '';
    let pendiente = false;
    try { pendiente = !!hayTrabajoSinGuardar(); } catch (e) { pendiente = false; }
    if (pendiente &&
        !global.confirm(`Tienes un pedido a medio capturar. Si cambias a ${sucursal.etiqueta} se pierde. ¿Cambiar de todos modos?`)) {
      return;
    }
    const botones = [...menu.querySelectorAll('button')];
    botones.forEach((b) => { b.disabled = true; });
    try {
      const r = await global.fetch('/api/auth/cambiar-sucursal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', [CABECERA]: negocioCargado },
        body: JSON.stringify({ negocioId: sucursal.negocioId }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        // Primero se avisa a las otras pestañas y luego se recarga ésta.
        anunciar(d.negocioId || sucursal.negocioId);
        recargar();
        return;
      }
      if (r.status === 409 && d.code === 'SUCURSAL_CAMBIADA') { recargar(); return; }
      if (r.status === 401) {
        global.location.href = '/login-negocio.html?redirect=' + encodeURIComponent(global.location.pathname + global.location.hash);
        return;
      }
      error.textContent = d.error || 'No se pudo cambiar de sucursal';
    } catch (e) {
      error.textContent = 'Sin conexión: no se cambió de sucursal';
    }
    botones.forEach((b) => { b.disabled = b.getAttribute('aria-checked') === 'true'; });
  }

  // ─── Arranque (lo llama el panel después de /api/auth/me) ───────────────
  async function iniciar({ negocioId, soporte = false, trabajoSinGuardar } = {}) {
    if (!negocioId || negocioCargado) return;
    negocioCargado = negocioId;
    if (typeof trabajoSinGuardar === 'function') hayTrabajoSinGuardar = trabajoSinGuardar;
    escuchar();
    anunciar(negocioId);
    if (soporte) return; // soporte entra y sale por Superadmin
    try {
      const r = await global.fetch('/api/auth/sucursales', { credentials: 'same-origin', headers: { [CABECERA]: negocioId } });
      if (r.status === 409) { recargar(); return; }
      if (!r.ok) return;
      const d = await r.json();
      if (d && (d.puedeCambiar || d.puedeAbrirSuperadmin === true) && Array.isArray(d.sucursales)) {
        pintarBoton(d.sucursales, d.puedeAbrirSuperadmin === true);
      }
    } catch (e) { /* sin botón: el panel sigue igual */ }
  }

  global.XaborCambioSucursal = { iniciar, recargar, CABECERA };
})(window);
