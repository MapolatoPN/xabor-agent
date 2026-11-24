// Avisos del panel: la campanita (24-nov-2026, pedido de Mario).
//
// Los avisos al dueño ya no van por WhatsApp: se ven aquí. El administrador
// ve en la cabecera un botón «🔔» con el número de avisos sin ver; al abrirlo,
// la lista de los últimos 7 días con «Ir al chat» y «Visto». Si el panel está
// abierto, el aviso llega al momento (evento WS `aviso_panel`) con un letrero
// abajo; si estaba cerrado, se ve al entrar.
//
// Solo administrador (index.html no lo inicia para el operador, y las rutas
// son de administrador). Si la bandera avisos_panel_v1 del negocio está
// apagada, el servidor responde { activo: false } y el botón no aparece.
//
// Todo el texto se pinta con textContent: un producto que escribió el cliente
// (aviso de negativa falsa) nunca se interpreta como HTML.
(function (global) {
  'use strict';

  const REFRESCO_MS = 3 * 60 * 1000;
  const REFRESCO_MIN_MS = 30 * 1000;
  const LETRERO_MS = 7000;
  const RUTA = '/api/admin/avisos-panel';

  let pedir = null;
  let irAlChat = null;
  let nombreDe = () => null;
  let activo = false;
  let avisos = [];
  let sinVer = 0;
  let ultimaCarga = 0;
  let cargando = null;
  let iniciado = false;

  // ─── Texto de cada aviso ────────────────────────────────────────────────
  function minutos(n) {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? `${Math.round(v)} min` : 'unos minutos';
  }

  function textoDeAviso(aviso) {
    const d = (aviso && aviso.datos && typeof aviso.datos === 'object') ? aviso.datos : {};
    const razon = typeof d.razon === 'string' && d.razon ? d.razon : '';
    switch (aviso && aviso.tipo) {
      case 'cliente_esperando':
        return { icono: '⏳', titulo: `Un cliente lleva ${minutos(d.minutos)} esperando respuesta`,
          detalle: 'El bot está en pausa porque alguien tomó la conversación. Contéstale o reactiva el bot en Chats.' };
      case 'revision_humana':
        return { icono: '🙋', titulo: 'Una conversación pasó a una persona',
          detalle: `${razon ? `Motivo: ${razon}. ` : ''}El bot ya no le contesta: atiéndela en Chats y al terminar usa «Revisé y atendí los pendientes».` };
      case 'bot_retomo':
        return { icono: '⏱️', titulo: `El bot retomó una conversación que nadie atendió en ${minutos(d.minutos)}`,
          detalle: `${razon ? `Había quedado pendiente porque ${razon}. ` : ''}Ese cliente estuvo sin respuesta todo ese rato: vale la pena revisar qué escribió.` };
      case 'fallas_bot': {
        const n = Number(d.errores);
        return { icono: '🚨', titulo: `El bot tuvo ${Number.isFinite(n) && n > 0 ? Math.round(n) : 'varios'} errores en 5 minutos`,
          detalle: 'Puede que algunos clientes no hayan recibido respuesta. Revisa Chats; si se repite, avisa a soporte.' };
      }
      case 'negativa_falsa': {
        const existen = Array.isArray(d.existen) && d.existen.length ? ` (${d.existen.join(', ')})` : '';
        return { icono: '🛑',
          titulo: d.negado ? `El bot iba a decir que no manejan «${d.negado}»` : 'El bot iba a negar algo que sí venden',
          detalle: `Sí lo tienen${existen}. Ese mensaje no salió: al cliente se le ofrecieron las opciones reales. Hay que revisar por qué no lo reconoció.` };
      }
      case 'pago_sin_proveedor':
        return { icono: '💳', titulo: 'Un cliente quiso pagar en línea y no hay forma de cobro configurada',
          detalle: 'El bot le pidió un momento. Atiéndelo en Chats.' };
      default:
        return { icono: '🔔', titulo: 'Aviso', detalle: '' };
    }
  }

  function cuando(iso, ahora = new Date()) {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return '';
    const min = Math.round((ahora.getTime() - t.getTime()) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const hora = t.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    if (t.toDateString() === ahora.toDateString()) return `hoy ${hora}`;
    const ayer = new Date(ahora); ayer.setDate(ahora.getDate() - 1);
    if (t.toDateString() === ayer.toDateString()) return `ayer ${hora}`;
    return `${t.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })} ${hora}`;
  }

  // ─── Estilos ────────────────────────────────────────────────────────────
  function estilos() {
    const doc = global.document;
    if (doc.getElementById('estilos-avisos-panel')) return;
    const st = doc.createElement('style');
    st.id = 'estilos-avisos-panel';
    st.textContent = `
#btn-avisos { display: inline-flex; align-items: center; gap: 5px; padding: 0 12px; }
#btn-avisos[hidden] { display: none; }
#btn-avisos .av-contador { background: #ef4444; color: #fff; border-radius: 10px; padding: 1px 6px; font-size: .7rem; font-weight: 700; line-height: 1.4; }
#btn-avisos .av-contador[hidden] { display: none; }
#menu-avisos { position: fixed; z-index: 10000; width: 380px; max-width: calc(100vw - 24px); max-height: min(70vh, 560px);
  overflow-y: auto; background: var(--color-surface, #fff); border: 1px solid var(--color-border-strong, #DEE2E6);
  border-radius: var(--radius-md, 8px); box-shadow: 0 10px 30px rgba(0,0,0,.14); }
#menu-avisos[hidden] { display: none; }
#menu-avisos .av-cabecera { position: sticky; top: 0; z-index: 1; background: var(--color-surface, #fff); display: flex;
  align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--color-border, #E9ECEF); font-weight: 700; color: var(--color-text-primary, #1A1D23); }
#menu-avisos .av-todos { border: 0; background: transparent; color: var(--color-brand, #FF6B35); font: inherit; font-size: .8rem;
  font-weight: 600; cursor: pointer; padding: 6px; min-height: 32px; }
#menu-avisos .av-todos:disabled { color: var(--color-text-muted, #9CA3AF); cursor: default; }
#menu-avisos .av-item { padding: 10px 12px; border-bottom: 1px solid var(--color-border, #E9ECEF); }
#menu-avisos .av-item.av-nuevo { background: var(--color-brand-light, #FFF4EF); }
#menu-avisos .av-item.av-visto { opacity: .65; }
#menu-avisos .av-titulo { font-weight: 700; font-size: .88rem; color: var(--color-text-primary, #1A1D23); }
#menu-avisos .av-detalle { font-size: .8rem; color: var(--color-text-secondary, #6B7280); margin-top: 3px; line-height: 1.35; }
#menu-avisos .av-meta { font-size: .72rem; color: var(--color-text-muted, #9CA3AF); margin-top: 4px; }
#menu-avisos .av-acciones { display: flex; gap: 8px; margin-top: 8px; }
#menu-avisos .av-acciones button { border: 1px solid var(--color-border-strong, #DEE2E6); background: var(--color-surface, #fff);
  color: var(--color-text-primary, #1A1D23); border-radius: 6px; padding: 6px 10px; font: inherit; font-size: .78rem;
  cursor: pointer; min-height: 32px; }
#menu-avisos .av-vacio, #menu-avisos .av-pie { padding: 14px 12px; font-size: .78rem; color: var(--color-text-muted, #9CA3AF); text-align: center; }
#menu-avisos .av-error { color: var(--color-danger, #EF4444); font-size: .8rem; padding: 6px 12px; }
#menu-avisos .av-error:empty { display: none; }
#letrero-aviso-panel { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: #1c1c1c; color: #fff;
  padding: 12px 20px; border-radius: 12px; font-weight: 700; font-size: .9rem; z-index: 9999;
  box-shadow: 0 4px 20px rgba(0,0,0,.2); max-width: 90vw; cursor: pointer; }
@media (max-width: 640px) {
  /* En el celular la cabecera va justa: el número va encima de la campana,
     como globito, para que el botón no empuje la página fuera de la pantalla. */
  #btn-avisos { position: relative; padding: 0 9px; gap: 0; }
  #btn-avisos .av-contador { position: absolute; top: 2px; right: 2px; min-width: 15px; box-sizing: border-box;
    padding: 0 4px; text-align: center; font-size: .6rem; line-height: 14px; }
}
@media print { #btn-avisos, #menu-avisos, #letrero-aviso-panel { display: none !important; } }`;
    doc.head.appendChild(st);
  }

  function el(tag, clase, texto) {
    const n = global.document.createElement(tag);
    if (clase) n.className = clase;
    if (texto !== undefined) n.textContent = texto;
    return n;
  }

  // ─── Botón ──────────────────────────────────────────────────────────────
  function menu() {
    const doc = global.document;
    let m = doc.getElementById('menu-avisos');
    if (!m) {
      m = el('div');
      m.id = 'menu-avisos';
      m.setAttribute('role', 'dialog');
      m.setAttribute('aria-label', 'Avisos');
      m.hidden = true;
      doc.body.appendChild(m);
    }
    return m;
  }

  function pintarBoton() {
    const btn = global.document.getElementById('btn-avisos');
    if (!btn) return;
    estilos();
    btn.hidden = !activo;
    if (!activo) { const m = global.document.getElementById('menu-avisos'); if (m) m.hidden = true; return; }
    btn.textContent = '';
    const icono = el('span', 'av-icono', '🔔');
    icono.setAttribute('aria-hidden', 'true');
    const contador = el('span', 'av-contador', sinVer > 99 ? '99+' : String(sinVer));
    contador.hidden = sinVer <= 0;
    btn.append(icono, contador);
    const etiqueta = sinVer ? `Avisos: ${sinVer} sin ver` : 'Avisos';
    btn.title = etiqueta;
    btn.setAttribute('aria-label', etiqueta);
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', menu().hidden ? 'false' : 'true');
  }

  // ─── Lista ──────────────────────────────────────────────────────────────
  function pintarMenu(error = '') {
    const m = menu();
    m.textContent = '';
    const cab = el('div', 'av-cabecera');
    cab.appendChild(el('span', '', sinVer ? `Avisos (${sinVer} sin ver)` : 'Avisos'));
    const todos = el('button', 'av-todos', 'Marcar todos como vistos');
    todos.type = 'button';
    todos.disabled = sinVer <= 0;
    todos.addEventListener('click', marcarTodos);
    cab.appendChild(todos);
    m.appendChild(cab);
    const err = el('div', 'av-error', error);
    err.setAttribute('role', 'alert');
    m.appendChild(err);

    if (!avisos.length) {
      m.appendChild(el('div', 'av-vacio', 'Sin avisos en los últimos 7 días.'));
      return;
    }
    for (const a of avisos) {
      const t = textoDeAviso(a);
      const item = el('div', `av-item ${a.visto_en ? 'av-visto' : 'av-nuevo'}`);
      item.dataset.aviso = a.id;
      item.appendChild(el('div', 'av-titulo', `${t.icono} ${t.titulo}`));
      if (t.detalle) item.appendChild(el('div', 'av-detalle', t.detalle));
      const quien = a.telefono ? (nombreDe(a.telefono) || a.telefono) : '';
      item.appendChild(el('div', 'av-meta', [cuando(a.creado_en), quien && `Cliente: ${quien}`].filter(Boolean).join(' · ')));
      const acciones = el('div', 'av-acciones');
      if (a.telefono && irAlChat) {
        const ir = el('button', 'av-ir', 'Ir al chat');
        ir.type = 'button';
        ir.addEventListener('click', () => abrirChat(a));
        acciones.appendChild(ir);
      }
      if (!a.visto_en) {
        const visto = el('button', 'av-marcar', 'Visto');
        visto.type = 'button';
        visto.addEventListener('click', () => marcarVisto(a));
        acciones.appendChild(visto);
      }
      if (acciones.childNodes.length) item.appendChild(acciones);
      m.appendChild(item);
    }
    m.appendChild(el('div', 'av-pie', 'Se muestran los últimos 7 días.'));
  }

  function colocar(btn, m) {
    const r = btn.getBoundingClientRect();
    const ancho = m.offsetWidth || 380;
    const izq = Math.max(12, Math.min(r.right - ancho, global.innerWidth - ancho - 12));
    m.style.top = `${Math.round(r.bottom + 6)}px`;
    m.style.left = `${Math.round(izq)}px`;
  }

  function abrir() {
    const btn = global.document.getElementById('btn-avisos');
    const m = menu();
    pintarMenu();
    m.hidden = false;
    if (btn) { colocar(btn, m); btn.setAttribute('aria-expanded', 'true'); }
    refrescar(true);
  }

  function cerrar() {
    const btn = global.document.getElementById('btn-avisos');
    const m = global.document.getElementById('menu-avisos');
    if (m) m.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  const menuAbierto = () => { const m = global.document.getElementById('menu-avisos'); return !!(m && !m.hidden); };

  function repintar(error) {
    pintarBoton();
    if (menuAbierto()) pintarMenu(error);
  }

  // ─── Servidor ───────────────────────────────────────────────────────────
  async function refrescar(forzar = false) {
    if (!pedir) return;
    if (cargando) return cargando;
    if (!forzar && Date.now() - ultimaCarga < REFRESCO_MIN_MS) return;
    // Solo se vuelve a dibujar si algo cambió: redibujar la lista abierta
    // sin motivo cambia los botones bajo el dedo de quien está por tocarlos.
    const huella = () => JSON.stringify([activo, sinVer, avisos]);
    const antes = huella();
    cargando = (async () => {
      try {
        const r = await pedir(RUTA);
        if (!r || !r.ok) {
          // 403/404: sin permiso o sin el módulo. Se esconde; un fallo de red
          // deja lo que ya se veía.
          if (r && (r.status === 403 || r.status === 404)) { activo = false; avisos = []; sinVer = 0; }
          return;
        }
        const d = await r.json();
        activo = !!(d && d.activo);
        avisos = activo && Array.isArray(d.avisos) ? d.avisos : [];
        sinVer = activo && Number.isFinite(Number(d.sinVer)) ? Number(d.sinVer) : 0;
        ultimaCarga = Date.now();
      } catch (e) {
        /* sin red: se reintenta en la siguiente vuelta */
      } finally {
        cargando = null;
        if (huella() !== antes) repintar();
      }
    })();
    return cargando;
  }

  async function marcarVisto(a) {
    if (!a || a.visto_en) return;
    try {
      const r = await pedir(`${RUTA}/${encodeURIComponent(a.id)}/visto`, { method: 'POST' });
      if (!r || !r.ok) throw new Error('rechazado');
      a.visto_en = new Date().toISOString();
      sinVer = Math.max(0, sinVer - 1);
      repintar();
    } catch (e) {
      repintar('No se pudo marcar el aviso. Intenta de nuevo.');
    }
  }

  async function marcarTodos() {
    try {
      const r = await pedir(`${RUTA}/visto-todos`, { method: 'POST' });
      if (!r || !r.ok) throw new Error('rechazado');
      const ahora = new Date().toISOString();
      for (const a of avisos) if (!a.visto_en) a.visto_en = ahora;
      sinVer = 0;
      repintar();
    } catch (e) {
      repintar('No se pudieron marcar los avisos. Intenta de nuevo.');
    }
  }

  function abrirChat(a) {
    cerrar();
    marcarVisto(a);
    try { irAlChat(a.telefono); } catch (e) { console.error('[Avisos panel] ir al chat:', e); }
  }

  // ─── En vivo ────────────────────────────────────────────────────────────
  function letrero(aviso) {
    const doc = global.document;
    const t = textoDeAviso(aviso);
    let l = doc.getElementById('letrero-aviso-panel');
    if (!l) {
      l = el('div');
      l.id = 'letrero-aviso-panel';
      l.setAttribute('role', 'status');
      // stopPropagation: el clic que abre la lista no debe llegar al
      // documento, que cierra la lista al hacer clic fuera de ella.
      l.addEventListener('click', (ev) => { ev.stopPropagation(); l.remove(); abrir(); });
      doc.body.appendChild(l);
    }
    l.textContent = `🔔 ${t.titulo}`;
    clearTimeout(l._quitar);
    l._quitar = setTimeout(() => l.remove(), LETRERO_MS);
  }

  function alEvento(aviso) {
    if (!aviso || typeof aviso !== 'object' || aviso.id === undefined || aviso.id === null) return;
    // El servidor solo lo emite con la bandera encendida: si este panel aún
    // no lo sabía (la encendieron con el panel abierto), se pregunta.
    if (!activo) { refrescar(true); return; }
    const id = String(aviso.id);
    if (avisos.some((a) => String(a.id) === id)) return;
    avisos.unshift({ ...aviso, id });
    if (!aviso.visto_en) sinVer += 1;
    repintar();
    letrero(aviso);
  }

  function iniciar(opciones = {}) {
    if (iniciado) return;
    if (typeof opciones.apiFetch !== 'function') return;
    iniciado = true;
    pedir = opciones.apiFetch;
    irAlChat = typeof opciones.irAlChat === 'function' ? opciones.irAlChat : null;
    if (typeof opciones.nombreDe === 'function') nombreDe = opciones.nombreDe;
    const doc = global.document;
    const btn = doc.getElementById('btn-avisos');
    if (btn) btn.onclick = (ev) => { ev.stopPropagation(); if (menuAbierto()) cerrar(); else abrir(); };
    doc.addEventListener('click', (ev) => {
      const m = doc.getElementById('menu-avisos');
      if (m && !m.hidden && !m.contains(ev.target)) cerrar();
    });
    doc.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && menuAbierto()) { cerrar(); if (btn) btn.focus(); } });
    global.addEventListener('resize', () => { const m = doc.getElementById('menu-avisos'); if (btn && m && !m.hidden) colocar(btn, m); });
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') refrescar(); });
    setInterval(() => { if (doc.visibilityState !== 'hidden') refrescar(true); }, REFRESCO_MS);
    refrescar(true);
  }

  global.XaborAvisosPanel = { iniciar, alEvento, refrescar, textoDeAviso, cuando };
})(typeof window !== 'undefined' ? window : globalThis);
