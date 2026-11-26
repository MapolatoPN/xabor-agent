// Asistente del restaurante, Fase 1: sus avisos dentro de la campanita.
//
// Cada mañana el servidor revisa las ventas de la sucursal con reglas fijas
// (src/asistenteRestaurante/) y deja hasta 3 avisos. Aquí se pintan en una
// sección propia de la lista de avisos-panel.js: el título, «Qué hacer», el
// número a revisar y la fecha, los números de apoyo (a la vista solo si se
// piden) y los botones Útil / No útil / No avisar de esto.
//
// Solo lo ve quien el servidor deja: administrador, bandera encendida, modo
// visible y en la lista de destinatarios. Si no, responde { activo: false }
// y esta sección no aparece. Todo se pinta con textContent.
(function (global) {
  'use strict';

  const RUTA = '/api/admin/asistente-restaurante/avisos';
  // Los avisos salen una vez al día: basta con preguntar cada 15 minutos, o
  // al abrir la lista.
  const REFRESCO_MS = 15 * 60 * 1000;
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const OPINIONES = [['util', 'Útil'], ['no_util', 'No útil'], ['no_avisar', 'No avisar de esto']];
  const ICONOS = {
    descuentos_altos: '🧾', cancelaciones_altas: '🧾', cortesias_altas: '🧾',
    ventas_sin_forma_pago: '⚠️', ventas_fuera_horario: '⚠️', ventas_incompletas: '⚠️',
    producto_baja: '📉', categoria_baja: '📉', canal_baja: '📉', dia_flojo: '📉', franja_floja: '📉',
    producto_sube: '📈', categoria_sube: '📈', canal_sube: '📈',
    clientes_dejaron: '👥', nuevos_regresan_menos: '👥', clientes_cambiaron: '👥',
    pedidos_grandes: '🛍️', combinaciones: '💡', poca_venta: '💡',
  };

  let pedir = null;
  let avisarCambio = () => {};
  let activo = false;
  let avisos = [];
  let sinVer = 0;
  let ultimaCarga = 0;
  let error = '';
  const abiertos = new Set();

  // ─── Formato ────────────────────────────────────────────────────────────
  function fechaCorta(f) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f || ''));
    return m ? `${Number(m[3])} ${MESES[Number(m[2]) - 1]}` : '';
  }

  function valor(v, formato) {
    if (v === null || v === undefined || v === '') return '—';
    if (formato === 'texto') return String(v);
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (formato === 'dinero') return `$${Math.round(n).toLocaleString('es-MX')}`;
    if (formato === 'pct') return `${(Math.round(n * 10) / 10).toLocaleString('es-MX')} %`;
    if (formato === 'decimal') return (Math.round(n * 100) / 100).toLocaleString('es-MX');
    return Math.round(n).toLocaleString('es-MX');
  }

  function textoRevisar(r) {
    if (!r || !r.numero) return '';
    const cuando = fechaCorta(r.el);
    const hoy = r.valor === null || r.valor === undefined ? '' : ` (hoy: ${valor(r.valor, r.formato)})`;
    return `Revisar${cuando ? ` el ${cuando}` : ''}: ${r.numero}${hoy}.`;
  }

  function el(tag, clase, texto) {
    const n = global.document.createElement(tag);
    if (clase) n.className = clase;
    if (texto !== undefined) n.textContent = texto;
    return n;
  }

  function boton(clase, texto, alClic) {
    const b = el('button', clase, texto);
    b.type = 'button';
    // stopPropagation: el clic no debe llegar al documento, que cierra la
    // lista al hacer clic fuera de ella (el nodo se redibuja al instante).
    b.addEventListener('click', (ev) => { ev.stopPropagation(); alClic(); });
    return b;
  }

  function estilos() {
    const doc = global.document;
    if (doc.getElementById('estilos-asistente-avisos')) return;
    const st = doc.createElement('style');
    st.id = 'estilos-asistente-avisos';
    st.textContent = `
#menu-avisos .as-seccion { padding: 8px 12px; background: var(--color-surface-2, #F8F9FA); border-bottom: 1px solid var(--color-border, #E9ECEF);
  font-size: .74rem; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; color: var(--color-text-secondary, #6B7280); }
#menu-avisos .as-item { padding: 10px 12px; border-bottom: 1px solid var(--color-border, #E9ECEF); }
#menu-avisos .as-item.as-nuevo { background: var(--color-brand-light, #FFF4EF); }
#menu-avisos .as-titulo { font-weight: 700; font-size: .88rem; line-height: 1.3; color: var(--color-text-primary, #1A1D23); }
#menu-avisos .as-meta { font-size: .72rem; color: var(--color-text-muted, #9CA3AF); margin-top: 3px; }
#menu-avisos .as-que, #menu-avisos .as-revisar { font-size: .8rem; color: var(--color-text-secondary, #6B7280); margin-top: 5px; line-height: 1.35; }
#menu-avisos .as-que b, #menu-avisos .as-revisar b { color: var(--color-text-primary, #1A1D23); }
#menu-avisos .as-detalle { margin-top: 8px; font-size: .78rem; color: var(--color-text-primary, #1A1D23); }
#menu-avisos .as-detalle[hidden] { display: none; }
#menu-avisos .as-numeros { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; margin: 0; }
#menu-avisos .as-numeros dt { color: var(--color-text-secondary, #6B7280); }
#menu-avisos .as-numeros dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
#menu-avisos .as-tabla-caja { overflow-x: auto; margin-top: 8px; }
#menu-avisos .as-tabla { border-collapse: collapse; width: 100%; font-size: .74rem; }
#menu-avisos .as-tabla th, #menu-avisos .as-tabla td { padding: 3px 6px; border-bottom: 1px solid var(--color-border, #E9ECEF); text-align: left; white-space: nowrap; }
#menu-avisos .as-tabla th { color: var(--color-text-secondary, #6B7280); font-weight: 600; }
#menu-avisos .as-tabla td.as-num { text-align: right; font-variant-numeric: tabular-nums; }
#menu-avisos .as-nota { margin-top: 6px; font-size: .72rem; color: var(--color-text-muted, #9CA3AF); }
#menu-avisos .as-acciones { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
#menu-avisos .as-acciones button { border: 1px solid var(--color-border-strong, #DEE2E6); background: var(--color-surface, #fff);
  color: var(--color-text-primary, #1A1D23); border-radius: 6px; padding: 6px 9px; font: inherit; font-size: .76rem; cursor: pointer; min-height: 32px; }
#menu-avisos .as-acciones button[aria-pressed="true"] { border-color: var(--color-brand, #FF6B35); color: var(--color-brand, #FF6B35); font-weight: 700; }
#menu-avisos .as-ver { border: 0 !important; background: transparent !important; color: var(--color-brand, #FF6B35) !important; padding-left: 0 !important; }
#menu-avisos .as-vacio, #menu-avisos .as-pie { padding: 12px; font-size: .76rem; color: var(--color-text-muted, #9CA3AF); text-align: center; }
#menu-avisos .as-error { color: var(--color-danger, #EF4444); font-size: .8rem; padding: 6px 12px; }
#menu-avisos .as-error:empty { display: none; }`;
    doc.head.appendChild(st);
  }

  // ─── Un aviso ───────────────────────────────────────────────────────────
  function pintarDetalle(a) {
    const d = a.detalle && typeof a.detalle === 'object' ? a.detalle : {};
    const caja = el('div', 'as-detalle');
    caja.hidden = !abiertos.has(a.id);
    const numeros = Array.isArray(d.numeros) ? d.numeros : [];
    if (numeros.length) {
      const dl = el('dl', 'as-numeros');
      for (const n of numeros) {
        if (!n || typeof n.etiqueta !== 'string') continue;
        dl.append(el('dt', '', n.etiqueta), el('dd', '', valor(n.valor, n.formato)));
      }
      caja.appendChild(dl);
    }
    const t = d.tabla && typeof d.tabla === 'object' ? d.tabla : null;
    if (t && Array.isArray(t.columnas) && Array.isArray(t.filas) && t.filas.length) {
      const formatos = Array.isArray(t.formatos) ? t.formatos : [];
      const tabla = el('table', 'as-tabla');
      const cab = el('tr');
      for (const c of t.columnas) cab.appendChild(el('th', '', String(c)));
      const thead = el('thead'); thead.appendChild(cab);
      const tbody = el('tbody');
      for (const f of t.filas) {
        if (!Array.isArray(f)) continue;
        const tr = el('tr');
        f.forEach((x, i) => {
          const fmt = formatos[i] || (typeof x === 'number' ? 'entero' : 'texto');
          tr.appendChild(el('td', fmt === 'texto' ? '' : 'as-num', valor(x, fmt)));
        });
        tbody.appendChild(tr);
      }
      tabla.append(thead, tbody);
      const envoltura = el('div', 'as-tabla-caja');
      envoltura.appendChild(tabla);
      caja.appendChild(envoltura);
    }
    if (typeof d.nota === 'string' && d.nota) caja.appendChild(el('div', 'as-nota', d.nota));
    return caja.childNodes.length ? caja : null;
  }

  function pintarAviso(a) {
    const item = el('div', `as-item ${a.visto ? 'as-visto' : 'as-nuevo'}`);
    item.dataset.asistente = a.id;
    item.appendChild(el('div', 'as-titulo', `${ICONOS[a.tipo] || '💡'} ${a.titulo || ''}`));
    const impacto = Number(a.impacto);
    item.appendChild(el('div', 'as-meta', [
      a.fecha ? `Revisión del ${fechaCorta(a.fecha)}` : '',
      Number.isFinite(impacto) && impacto > 0 ? `${valor(impacto, 'dinero')} en juego` : '',
    ].filter(Boolean).join(' · ')));
    if (a.sugerencia) {
      const q = el('div', 'as-que');
      q.append(el('b', '', 'Qué hacer: '), global.document.createTextNode(a.sugerencia));
      item.appendChild(q);
    }
    const rev = textoRevisar(a.revisar);
    if (rev) item.appendChild(el('div', 'as-revisar', rev));
    const detalle = pintarDetalle(a);
    const acciones = el('div', 'as-acciones');
    if (detalle) {
      const ver = boton('as-ver', abiertos.has(a.id) ? 'Ocultar números' : 'Ver números', () => {
        if (abiertos.has(a.id)) abiertos.delete(a.id); else abiertos.add(a.id);
        avisarCambio();
      });
      ver.setAttribute('aria-expanded', abiertos.has(a.id) ? 'true' : 'false');
      acciones.appendChild(ver);
    }
    for (const [clave, texto] of OPINIONES) {
      const b = boton(`as-opinion as-${clave}`, texto, () => opinar(a.id, clave));
      b.setAttribute('aria-pressed', a.opinion === clave ? 'true' : 'false');
      acciones.appendChild(b);
    }
    if (!a.visto) acciones.appendChild(boton('as-marcar', 'Visto', () => marcarVisto(a.id)));
    if (detalle) item.appendChild(detalle);
    item.appendChild(acciones);
    return item;
  }

  // ─── Servidor ───────────────────────────────────────────────────────────
  async function refrescar({ abierto = false } = {}) {
    if (!pedir) return;
    if (!abierto && ultimaCarga && Date.now() - ultimaCarga < REFRESCO_MS) return;
    try {
      const r = await pedir(RUTA);
      if (!r || !r.ok) {
        if (r && (r.status === 401 || r.status === 403 || r.status === 404)) { activo = false; avisos = []; sinVer = 0; }
        return;
      }
      const d = await r.json();
      activo = !!(d && d.activo);
      avisos = activo && Array.isArray(d.avisos) ? d.avisos.map((a) => ({ ...a, id: String(a.id) })) : [];
      sinVer = activo && Number.isFinite(Number(d.sinVer)) ? Number(d.sinVer) : 0;
      ultimaCarga = Date.now();
    } catch (e) {
      /* sin red: se reintenta en la siguiente vuelta */
    }
  }

  // Los botones guardan el id, no el objeto: la lista se vuelve a pedir al
  // abrirla y un objeto viejo ya no es el que se pinta.
  const vigente = (id) => avisos.find((x) => x.id === id) || null;

  async function marcarVisto(id) {
    const a = vigente(id);
    if (!a || a.visto) return;
    try {
      const r = await pedir(`${RUTA}/${encodeURIComponent(id)}/visto`, { method: 'POST' });
      if (!r || !r.ok) throw new Error('rechazado');
      const x = vigente(id);
      if (x && !x.visto) { x.visto = true; sinVer = Math.max(0, sinVer - 1); }
      error = '';
    } catch (e) {
      error = 'No se pudo marcar el aviso del asistente. Intenta de nuevo.';
    }
    avisarCambio();
  }

  async function opinar(id, opinion) {
    try {
      const r = await pedir(`${RUTA}/${encodeURIComponent(id)}/opinion`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opinion }),
      });
      if (!r || !r.ok) throw new Error('rechazado');
      error = '';
      const a = vigente(id);
      if (a) {
        a.opinion = opinion;
        if (opinion === 'no_avisar') {
          // Ese aviso ya no vuelve: se quita de la lista.
          avisos = avisos.filter((x) => x.id !== id);
          if (!a.visto) sinVer = Math.max(0, sinVer - 1);
          abiertos.delete(id);
        } else if (!a.visto) {
          // Opinar es haberlo visto.
          await marcarVisto(id);
          return;
        }
      }
    } catch (e) {
      error = 'No se pudo guardar tu opinión. Intenta de nuevo.';
    }
    avisarCambio();
  }

  async function marcarTodos() {
    const r = await pedir(`${RUTA}/visto-todos`, { method: 'POST' });
    if (!r || !r.ok) throw new Error('rechazado');
    for (const a of avisos) a.visto = true;
    sinVer = 0;
  }

  // ─── La fuente que usa avisos-panel.js ──────────────────────────────────
  const fuente = {
    id: 'asistente',
    iniciar(ctx) {
      pedir = ctx.pedir;
      if (typeof ctx.repintar === 'function') avisarCambio = ctx.repintar;
      estilos();
    },
    refrescar,
    marcarTodos,
    activo: () => activo,
    sinVer: () => sinVer,
    huella: () => JSON.stringify([activo, sinVer, avisos, error, [...abiertos]]),
    pintar(menu) {
      menu.appendChild(el('div', 'as-seccion', 'Asistente del restaurante'));
      const err = el('div', 'as-error', error);
      err.setAttribute('role', 'alert');
      menu.appendChild(err);
      if (!avisos.length) {
        menu.appendChild(el('div', 'as-vacio', 'Sin avisos del asistente en los últimos 14 días.'));
        return;
      }
      for (const a of avisos) menu.appendChild(pintarAviso(a));
      menu.appendChild(el('div', 'as-pie', 'Del asistente se muestran los últimos 14 días. Salen de reglas fijas sobre tus ventas.'));
    },
  };

  global.XaborAsistenteAvisos = { fuente, valor, fechaCorta, textoRevisar };
  if (global.XaborAvisosPanel && typeof global.XaborAvisosPanel.agregarFuente === 'function') {
    global.XaborAvisosPanel.agregarFuente(fuente);
  }
})(typeof window !== 'undefined' ? window : globalThis);
