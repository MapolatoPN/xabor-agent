// Asistente del restaurante, Fase 4: la pestaña «Asistente» de Reportes.
//
// Pedido del dueño del 27-nov-2026: las recomendaciones en pantalla, «no
// cuadros grandes de texto, sino algo más estético», y dentro de Reportes,
// «ya que la información viene de ahí». La maqueta aprobada es la v7.
//
// Arriba, «Cómo va el día»: la venta de hoy hasta esta hora contra el mismo
// día de la semana pasada, y la venta por hora de los dos días. Abajo, lo que
// eligió la revisión de la mañana, una tarjeta por aviso: su título corto, la
// cifra grande, una gráfica pequeña y «qué hacer». El texto largo, los
// números y la tabla van detrás de «Ver números».
//
// Los datos los arma el servidor (src/asistenteRestaurante/pantalla.js) y
// solo para quien puede verlos: administrador de la sucursal, con el asistente
// encendido, «Mostrar en Reportes» y en la lista de quién lo ve. Si no,
// responde { activo: false } y la pestaña no aparece. Todo se pinta con
// textContent: ningún texto de la base se interpreta como HTML.
(function (global) {
  'use strict';

  const RUTA = '/api/admin/asistente-restaurante/pantalla';
  const MINUTOS_ESTADO = 10;       // cada cuánto se vuelve a preguntar si se ve la pestaña
  const MINUTOS_REFRESCO = 5;      // «Cómo va el día» se actualiza solo mientras se ve
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const SVG = 'http://www.w3.org/2000/svg';

  // Íconos de trazo (24×24). Son constantes: nunca llevan datos de la base.
  const ICONOS = {
    reloj: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0 -18', 'M12 7v5l3 3'],
    chispa: ['M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z'],
    sube: ['M12 19V5', 'M18 11l-6 -6l-6 6'],
    baja: ['M12 5v14', 'M18 13l-6 6l-6 -6'],
    control: ['M5 21v-16a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16l-3 -2l-2 2l-2 -2l-2 2l-2 -2l-3 2', 'M9 7h6', 'M9 11h6', 'M13 15h2'],
    ventas: ['M3 17l6 -6l4 4l8 -8', 'M14 7h7v7'],
    clientes: ['M9 3a4 4 0 1 0 0 8a4 4 0 1 0 0 -8', 'M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2', 'M16 3.13a4 4 0 0 1 0 7.75', 'M21 21v-2a4 4 0 0 0 -3 -3.85'],
    menu: ['M4 19h16', 'M4 15c0 -4.4 3.6 -8 8 -8s8 3.6 8 8', 'M12 4v3'],
    flecha: ['M5 12h14', 'M13 18l6 -6', 'M13 6l6 6'],
    util: ['M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3'],
    noUtil: ['M7 13v-8a1 1 0 0 0 -1 -1h-2a1 1 0 0 0 -1 1v7a1 1 0 0 0 1 1h3a4 4 0 0 1 4 4v1a2 2 0 0 0 4 0v-5h3a2 2 0 0 0 2 -2l-1 -5a2 3 0 0 0 -2 -2h-7a3 3 0 0 0 -3 3'],
    abajo: ['M6 9l6 6l6 -6'],
  };

  const E = {
    estado: null, estadoEn: 0, pidiendoEstado: null,
    cont: null, datos: null, cargando: false, error: '', temporizador: null,
    abiertos: new Set(), quitados: new Set(), errores: new Map(),
  };

  // Quien entra directo a #reportes/asistente llega antes de saber si puede
  // ver la pestaña (nace oculta): el panel le diría «No tienes acceso». Este
  // archivo corre antes del arranque, así que la dirección pasa a Ventas
  // (#reportes) y, ya confirmada la pestaña, se le lleva a donde iba.
  let destinoInicial = global.location && global.location.hash === '#reportes/asistente';
  if (destinoInicial) { try { global.history.replaceState(null, '', '#reportes'); } catch { destinoInicial = false; } }

  const $ = (id) => global.document.getElementById(id);

  // ─── Formato ────────────────────────────────────────────────────────────
  const dinero = (n) => `$${Math.round(Number(n) || 0).toLocaleString('es-MX')}`;
  const entero = (n) => Math.round(Number(n) || 0).toLocaleString('es-MX');
  function valor(v, formato) {
    if (v === null || v === undefined || v === '') return '—';
    if (formato === 'texto') return String(v);
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    if (formato === 'dinero') return dinero(n);
    if (formato === 'pct') return `${(Math.round(n * 10) / 10).toLocaleString('es-MX')} %`;
    if (formato === 'decimal') return (Math.round(n * 100) / 100).toLocaleString('es-MX');
    // Mejora 2: un cambio en pesos con su signo.
    if (formato === 'cambio') return `${n < 0 ? '−' : '+'}${dinero(Math.abs(n))}`;
    return entero(n);
  }
  function partes(f) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f || ''));
    return m ? { a: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  }
  const fechaCorta = (f) => { const p = partes(f); return p ? `${p.d} ${MESES_CORTOS[p.m - 1]}` : ''; };
  function fechaLarga(f) {
    const p = partes(f);
    if (!p) return '';
    const dia = DIAS[new Date(Date.UTC(p.a, p.m - 1, p.d, 12)).getUTCDay()];
    return `${dia[0].toUpperCase()}${dia.slice(1)} ${p.d} de ${MESES[p.m - 1]}`;
  }
  // «$6 mil», «$850»: la escala de la gráfica de horas.
  const escala = (n) => (n >= 1000 ? `$${(Math.round(n / 100) / 10).toLocaleString('es-MX')} mil` : dinero(n));
  function textoRevisar(r) {
    if (!r || !r.numero) return '';
    const cuando = fechaCorta(r.el);
    const hoy = r.valor === null || r.valor === undefined ? '' : ` (hoy: ${valor(r.valor, r.formato)})`;
    return `Para revisar${cuando ? ` el ${cuando}` : ''}: ${r.numero}${hoy}.`;
  }

  // ─── DOM ────────────────────────────────────────────────────────────────
  function el(tag, clase, texto) {
    const n = global.document.createElement(tag);
    if (clase) n.className = clase;
    if (texto !== undefined && texto !== null) n.textContent = String(texto);
    return n;
  }
  function icono(nombre, tam = 18) {
    const s = global.document.createElementNS(SVG, 'svg');
    s.setAttribute('width', String(tam)); s.setAttribute('height', String(tam));
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    for (const d of ICONOS[nombre] || []) { const p = global.document.createElementNS(SVG, 'path'); p.setAttribute('d', d); s.appendChild(p); }
    return s;
  }
  function boton(clase, contenido, alClic, etiqueta) {
    const b = el('button', clase);
    b.type = 'button';
    for (const c of [].concat(contenido)) b.appendChild(typeof c === 'string' ? global.document.createTextNode(c) : c);
    if (etiqueta) { b.setAttribute('aria-label', etiqueta); b.title = etiqueta; }
    b.addEventListener('click', alClic);
    return b;
  }

  function estilos() {
    if ($('asp-estilos')) return;
    const s = el('style');
    s.id = 'asp-estilos';
    s.textContent = `
.asp { display:flex; flex-direction:column; gap:16px; max-width:1040px; color:#1A1D23; }
.asp-cabeza { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; }
.asp-fecha { font-size:0.9rem; font-weight:600; color:#374151; }
.asp-chips { display:flex; flex-wrap:wrap; gap:8px; }
.asp-chip { display:inline-flex; align-items:center; gap:6px; background:#fff; border:1px solid #E9ECEF; border-radius:9999px; padding:5px 11px; font-size:0.75rem; color:#374151; }
.asp-chip svg { color:#6B7280; } .asp-chip.ia svg { color:#C2410C; }
.asp-caja { background:#fff; border:1px solid #E9ECEF; border-radius:16px; }
.asp-dia { padding:20px; display:flex; flex-wrap:wrap; gap:24px; }
.asp-dia-num { flex:1 1 230px; min-width:0; display:flex; flex-direction:column; gap:10px; }
.asp-rotulo { font-size:0.8rem; font-weight:600; color:#6B7280; }
.asp-venta { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.asp-venta-num { font-size:2.2rem; font-weight:800; letter-spacing:-0.03em; line-height:1; font-variant-numeric:tabular-nums; }
.asp-pildora { display:inline-flex; align-items:center; gap:4px; border-radius:9999px; padding:5px 10px; font-size:0.8rem; font-weight:700; }
.asp-pildora.sube { background:#ECFDF5; color:#047857; } .asp-pildora.baja { background:#FEF2F2; color:#B91C1C; } .asp-pildora.igual { background:#F3F4F6; color:#374151; }
.asp-antes { font-size:0.82rem; color:#374151; }
.asp-mini { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.asp-mini > div { background:#F8F9FA; border-radius:12px; padding:10px 12px; display:flex; flex-direction:column; gap:2px; min-width:0; }
.asp-mini span { font-size:0.75rem; color:#6B7280; } .asp-mini b { font-size:1.15rem; font-weight:700; font-variant-numeric:tabular-nums; }
.asp-nota { font-size:0.75rem; color:#6B7280; }
.asp-horas { flex:1.3 1 300px; min-width:0; margin:0; display:flex; flex-direction:column; gap:8px; }
.asp-horas-cab { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
.asp-leyenda { display:flex; gap:12px; font-size:0.75rem; color:#374151; }
.asp-leyenda span { display:inline-flex; align-items:center; gap:6px; }
.asp-leyenda i { width:10px; height:10px; border-radius:3px; display:inline-block; }
.asp-graf-horas { position:relative; height:150px; border-bottom:1px solid #DEE2E6; }
.asp-graf-horas .asp-guia { position:absolute; left:0; right:0; border-top:1px dashed #EEF0F2; }
.asp-graf-horas .asp-eje { position:absolute; left:0; font-size:0.68rem; color:#6B7280; }
.asp-barras { position:absolute; left:44px; right:0; bottom:0; top:14px; display:flex; align-items:flex-end; gap:4px; }
.asp-par { flex:1 1 0; height:100%; display:flex; align-items:flex-end; justify-content:center; gap:2px; min-width:0; }
.asp-par i { display:block; width:42%; max-width:14px; border-radius:4px 4px 0 0; }
.asp-etiquetas-horas { display:flex; gap:4px; padding-left:44px; }
.asp-etiquetas-horas span { flex:1 1 0; text-align:center; font-size:0.68rem; color:#6B7280; min-width:0; }
.asp-titulo { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:8px; }
.asp-titulo h2 { margin:0; font-size:1.05rem; font-weight:800; }
.asp-tarjeta { padding:16px 18px; display:flex; flex-direction:column; gap:10px; }
.asp-fila { display:flex; flex-wrap:wrap; align-items:center; gap:14px; }
.asp-icono { flex:none; width:40px; height:40px; border-radius:12px; display:inline-flex; align-items:center; justify-content:center; }
.asp-que { flex:1 1 180px; min-width:0; display:flex; flex-direction:column; gap:3px; }
.asp-etiqueta { font-size:0.68rem; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; }
.asp-que h3 { margin:0; font-size:1rem; font-weight:700; overflow-wrap:anywhere; }
.asp-cifra { display:flex; flex-direction:column; align-items:flex-end; gap:2px; text-align:right; }
.asp-cifra b { font-size:1.5rem; font-weight:800; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; }
.asp-cifra span { font-size:0.75rem; color:#6B7280; }
.asp-serie { display:flex; align-items:flex-end; gap:3px; height:46px; }
.asp-serie i { display:block; width:8px; border-radius:3px 3px 0 0; background:#D1D5DB; }
.asp-aa { width:120px; display:flex; flex-direction:column; gap:6px; }
.asp-aa > div { height:10px; background:#F1F3F5; border-radius:9999px; }
.asp-aa > div > i { display:block; height:10px; border-radius:9999px; }
.asp-aa span { font-size:0.68rem; color:#6B7280; }
.asp-caras { display:flex; align-items:center; padding-right:6px; }
.asp-caras span { width:30px; height:30px; margin-right:-6px; border-radius:9999px; border:2px solid #fff; font-size:0.68rem; font-weight:700; display:inline-flex; align-items:center; justify-content:center; }
.asp-caras span.mas { background:#F3F4F6; color:#374151; }
.asp-datos { display:flex; flex-wrap:wrap; gap:6px; margin:0; padding:0; list-style:none; }
.asp-datos li { background:#F8F9FA; border-radius:9999px; padding:3px 10px; font-size:0.75rem; color:#374151; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.asp-accion { display:flex; flex-wrap:wrap; align-items:center; gap:6px; border-top:1px solid #F1F3F5; padding-top:6px; }
.asp-accion > svg { flex:none; color:#C2410C; }
.asp-hacer { flex:1 1 220px; min-width:0; font-size:0.82rem; color:#374151; }
.asp-op { width:44px; height:44px; border:0; background:transparent; border-radius:10px; color:#6B7280; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; }
.asp-op:hover { background:#F3F4F6; }
.asp-op[aria-pressed="true"] { background:#FFF4EF; color:#C2410C; }
.asp-ir { min-height:44px; border:1px solid #FED7C3; background:#FFF4EF; color:#C2410C; border-radius:10px; font:inherit; font-size:0.82rem; font-weight:700; display:inline-flex; align-items:center; gap:4px; cursor:pointer; padding:0 12px; }
.asp-ir:hover { background:#FFE8DC; }
.asp-ver { min-height:44px; border:0; background:transparent; color:#C2410C; font:inherit; font-size:0.82rem; font-weight:600; display:inline-flex; align-items:center; gap:2px; cursor:pointer; padding:0 6px; }
.asp-ver svg { transition:transform .15s; } .asp-ver[aria-expanded="true"] svg { transform:rotate(180deg); }
.asp-detalle { border-top:1px solid #F1F3F5; padding-top:10px; display:flex; flex-direction:column; gap:10px; font-size:0.82rem; color:#374151; }
.asp-detalle p { margin:0; line-height:1.45; }
.asp-numeros { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; }
.asp-numeros > div { background:#F8F9FA; border-radius:10px; padding:8px 10px; display:flex; flex-direction:column; gap:2px; min-width:0; }
.asp-numeros span { font-size:0.72rem; color:#6B7280; } .asp-numeros b { font-size:0.95rem; font-variant-numeric:tabular-nums; }
.asp-tabla-env { overflow-x:auto; }
.asp-tabla { width:100%; border-collapse:collapse; font-size:0.8rem; }
.asp-tabla th { text-align:left; font-size:0.72rem; color:#6B7280; font-weight:700; padding:6px 8px; border-bottom:1px solid #F1F3F5; }
.asp-tabla td { padding:6px 8px; border-bottom:1px solid #F8F9FA; vertical-align:top; overflow-wrap:anywhere; }
.asp-tabla .n { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
.asp-callar { align-self:flex-start; min-height:44px; background:#fff; border:1px solid #E9ECEF; border-radius:10px; padding:0 14px; font:inherit; font-size:0.8rem; color:#374151; cursor:pointer; }
.asp-error { color:#B91C1C; font-size:0.78rem; }
.asp-vacio { padding:22px; text-align:center; color:#6B7280; font-size:0.88rem; display:flex; flex-direction:column; align-items:center; gap:10px; }
.asp-reintentar { min-height:44px; background:#fff; border:1px solid #DEE2E6; border-radius:10px; padding:0 16px; font:inherit; font-weight:600; cursor:pointer; }
.asp-tope { background:#FFFBEB; border:1px solid #FDE68A; color:#92400E; border-radius:12px; padding:10px 14px; font-size:0.8rem; }
.asp-pie { font-size:0.75rem; color:#6B7280; }
.asp-g-control .asp-icono { background:#FEF3C7; color:#92400E; } .asp-g-control .asp-etiqueta { color:#92400E; }
.asp-g-ventas .asp-icono { background:#EFF6FF; color:#1D4ED8; } .asp-g-ventas .asp-etiqueta { color:#1D4ED8; }
.asp-g-clientes .asp-icono { background:#F3E8FF; color:#6B21A8; } .asp-g-clientes .asp-etiqueta { color:#6B21A8; }
.asp-g-menu .asp-icono { background:#ECFDF5; color:#047857; } .asp-g-menu .asp-etiqueta { color:#047857; }
@media (max-width: 600px) {
  .asp-dia { padding:16px; gap:18px; } .asp-venta-num { font-size:1.9rem; }
  .asp-tarjeta { padding:14px; } .asp-cifra { align-items:flex-start; text-align:left; }
}
`;
    global.document.head.appendChild(s);
  }

  // ─── ¿Se ve la pestaña? ─────────────────────────────────────────────────
  function puedePreguntar() {
    // ROL y MODULOS son del panel (index.html); el permiso de verdad es del servidor.
    try { return ROL === 'admin' && Array.isArray(MODULOS) && MODULOS.includes('pos'); } catch { return false; }
  }

  function vistaActiva() {
    for (const v of ['asistente', 'ventas', 'productos', 'transacciones', 'ajustes']) {
      const n = $('vista-' + v);
      if (n && n.style.display === 'block') return v;
    }
    return null;
  }

  function aplicarEstado(activo) {
    const b = $('pest-asistente');
    if (!b) return;
    const antes = b.style.display !== 'none';
    b.style.display = activo ? '' : 'none';
    const tab = vistaActiva();
    if (antes !== activo && tab && typeof global.navColocarPestanas === 'function') global.navColocarPestanas(tab);
    // Si se apagó mientras se veía, se vuelve a Ventas.
    if (!activo && tab === 'asistente' && typeof global.bnavTab === 'function') global.bnavTab('ventas');
    const destino = destinoInicial;
    destinoInicial = false;
    if (activo && destino && tab === 'ventas' && typeof global.bnavTab === 'function') global.bnavTab('asistente');
  }

  // `forzar`: sin la memoria de 10 minutos (al guardar la configuración).
  async function revisarPestana({ forzar = false } = {}) {
    if (!puedePreguntar()) { aplicarEstado(false); return false; }
    const fresco = !forzar && E.estado !== null && Date.now() - E.estadoEn < MINUTOS_ESTADO * 60000;
    if (fresco) { aplicarEstado(E.estado); return E.estado; }
    if (E.pidiendoEstado) return E.pidiendoEstado;
    E.pidiendoEstado = (async () => {
      let activo = false;
      try {
        const r = await apiFetch(`${RUTA}?solo=estado`);
        const d = await r.json().catch(() => null);
        activo = !!(r.ok && d && d.activo === true);
        E.estado = activo; E.estadoEn = Date.now();
      } catch {
        activo = E.estado === true; // sin red se conserva lo último que se supo
      } finally {
        E.pidiendoEstado = null;
      }
      aplicarEstado(activo);
      return activo;
    })();
    return E.pidiendoEstado;
  }

  // ─── «Cómo va el día» ───────────────────────────────────────────────────
  function pintarDia(c) {
    const caja = el('section', 'asp-caja asp-dia');
    caja.setAttribute('aria-label', 'Cómo va el día');
    if (!c) {
      const v = el('div', 'asp-vacio', 'No se pudo leer cómo va el día. Las recomendaciones de abajo sí están al día.');
      v.appendChild(boton('asp-reintentar', 'Reintentar', () => cargar()));
      caja.appendChild(v);
      return caja;
    }
    const izq = el('div', 'asp-dia-num');
    izq.appendChild(el('span', 'asp-rotulo', `Cómo va el día · hasta las ${c.horaCorte}`));
    const venta = el('div', 'asp-venta');
    venta.appendChild(el('span', 'asp-venta-num', dinero(c.actual.venta)));
    if (c.cambioPct !== null && c.cambioPct !== undefined) {
      const tono = c.cambioPct > 0 ? 'sube' : c.cambioPct < 0 ? 'baja' : 'igual';
      const p = el('span', `asp-pildora ${tono}`);
      if (tono !== 'igual') p.appendChild(icono(tono, 14));
      p.appendChild(global.document.createTextNode(`${Math.abs(c.cambioPct).toLocaleString('es-MX')} %`));
      p.setAttribute('aria-label', `${tono === 'sube' ? 'Sube' : tono === 'baja' ? 'Baja' : 'Igual'} ${Math.abs(c.cambioPct).toLocaleString('es-MX')} % contra el ${c.comparadoCon} pasado`);
      venta.appendChild(p);
    }
    izq.appendChild(venta);
    const antes = el('span', 'asp-antes');
    if (c.antes.tickets) {
      antes.appendChild(global.document.createTextNode(`El ${c.comparadoCon} pasado a esta hora: `));
      antes.appendChild(el('b', null, dinero(c.antes.venta)));
    } else antes.textContent = `El ${c.comparadoCon} pasado no hubo ventas a esta hora para comparar.`;
    izq.appendChild(antes);
    const mini = el('div', 'asp-mini');
    const cuadro = (rotulo, ahora, antesTxt) => {
      const d = el('div');
      d.appendChild(el('span', null, rotulo)); d.appendChild(el('b', null, ahora)); d.appendChild(el('span', null, antesTxt));
      return d;
    };
    mini.appendChild(cuadro('Tickets', entero(c.actual.tickets), `antes ${entero(c.antes.tickets)}`));
    mini.appendChild(cuadro('Ticket promedio', c.actual.tickets ? dinero(c.actual.promedio) : '—', `antes ${c.antes.tickets ? dinero(c.antes.promedio) : '—'}`));
    izq.appendChild(mini);
    if (c.actual.grandes) {
      izq.appendChild(el('span', 'asp-nota',
        `Aparte, ${c.actual.grandes === 1 ? '1 pedido grande' : `${entero(c.actual.grandes)} pedidos grandes`} por ${dinero(c.actual.grandesVenta)}: no entra${c.actual.grandes === 1 ? '' : 'n'} en la comparación.`));
    }
    caja.appendChild(izq);
    caja.appendChild(pintarHoras(c));
    return caja;
  }

  function pintarHoras(c) {
    const fig = el('figure', 'asp-horas');
    const cab = el('div', 'asp-horas-cab');
    cab.appendChild(el('figcaption', 'asp-rotulo', 'Venta por hora'));
    const ley = el('div', 'asp-leyenda');
    const muestra = (color, txt) => { const s = el('span'); const i = el('i'); i.style.background = color; s.appendChild(i); s.appendChild(global.document.createTextNode(txt)); return s; };
    ley.appendChild(muestra('var(--color-brand, #FF6B35)', 'Hoy'));
    ley.appendChild(muestra('#CBD5E1', `${c.comparadoCon[0].toUpperCase()}${c.comparadoCon.slice(1)} pasado`));
    cab.appendChild(ley);
    fig.appendChild(cab);
    const horas = Array.isArray(c.porHora) ? c.porHora : [];
    if (!horas.length) { fig.appendChild(el('div', 'asp-vacio', 'Todavía no hay ventas hoy ni el mismo día de la semana pasada.')); return fig; }
    const max = Math.max(1, ...horas.map((h) => Math.max(Number(h.hoy) || 0, Number(h.antes) || 0)));
    const graf = el('div', 'asp-graf-horas');
    graf.setAttribute('role', 'img');
    graf.setAttribute('aria-label', `Venta por hora de las ${horas[0].hora} a las ${horas[horas.length - 1].hora}: hoy contra el ${c.comparadoCon} pasado`);
    const g1 = el('div', 'asp-guia'); g1.style.top = '14px'; graf.appendChild(g1);
    const g2 = el('div', 'asp-guia'); g2.style.top = 'calc(14px + (100% - 14px) / 2)'; graf.appendChild(g2);
    const e1 = el('span', 'asp-eje', escala(max)); e1.style.top = '0'; graf.appendChild(e1);
    const e2 = el('span', 'asp-eje', escala(max / 2)); e2.style.top = 'calc((100% - 14px) / 2)'; graf.appendChild(e2);
    const barras = el('div', 'asp-barras');
    const etiquetas = el('div', 'asp-etiquetas-horas');
    const cada = horas.length > 10 ? 2 : 1;
    horas.forEach((h, i) => {
      const par = el('div', 'asp-par');
      par.title = `${h.hora}:00 · hoy ${h.hoy === null ? 'todavía no' : dinero(h.hoy)} · ${c.comparadoCon} pasado ${dinero(h.antes)}`;
      const a = el('i'); a.style.background = '#CBD5E1'; a.style.height = `${Math.max(h.antes > 0 ? 2 : 0, (h.antes / max) * 100)}%`;
      const b = el('i'); b.style.background = 'var(--color-brand, #FF6B35)'; b.style.height = h.hoy === null ? '0' : `${Math.max(h.hoy > 0 ? 2 : 0, (h.hoy / max) * 100)}%`;
      par.appendChild(a); par.appendChild(b);
      barras.appendChild(par);
      etiquetas.appendChild(el('span', null, i % cada === 0 ? String(h.hora) : ''));
    });
    graf.appendChild(barras);
    fig.appendChild(graf);
    fig.appendChild(etiquetas);
    return fig;
  }

  // ─── Las tarjetas ───────────────────────────────────────────────────────
  function pintarGrafica(t) {
    const g = t.grafica;
    if (!g) return null;
    if (g.tipo === 'serie' && Array.isArray(g.valores) && g.valores.length) {
      const max = Math.max(1, ...g.valores.map((x) => Number(x) || 0));
      const d = el('div', 'asp-serie');
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', `${g.etiqueta || 'Por semana'}: ${g.valores.map((x) => valor(x, g.formato)).join(', ')}; la última es esta semana`);
      d.title = `${g.etiqueta || 'Por semana'} (la última es esta semana)`;
      g.valores.forEach((x, i) => {
        const b = el('i');
        b.style.height = `${Math.max(2, Math.round(((Number(x) || 0) / max) * 46))}px`;
        if (i === g.valores.length - 1) b.style.background = 'currentColor';
        d.appendChild(b);
      });
      // La última barra va del color de la tarjeta.
      d.style.color = t.grupo === 'control' ? '#92400E' : '#1D4ED8';
      return d;
    }
    if (g.tipo === 'antesAhora') {
      const max = Math.max(Number(g.antes) || 0, Number(g.ahora) || 0, 1);
      const [ea, eb] = Array.isArray(g.etiquetas) ? g.etiquetas : ['Antes', 'Ahora'];
      const d = el('div', 'asp-aa');
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', `${ea}: ${valor(g.antes, g.formato)}; ${eb}: ${valor(g.ahora, g.formato)}`);
      d.title = `${ea}: ${valor(g.antes, g.formato)} · ${eb}: ${valor(g.ahora, g.formato)}`;
      const barra = (v, color) => { const f = el('div'); const i = el('i'); i.style.width = `${Math.max(2, Math.round(((Number(v) || 0) / max) * 100))}%`; i.style.background = color; f.appendChild(i); return f; };
      d.appendChild(barra(g.antes, '#CBD5E1'));
      d.appendChild(barra(g.ahora, 'var(--color-brand, #FF6B35)'));
      d.appendChild(el('span', null, 'antes · ahora'));
      return d;
    }
    if (g.tipo === 'iniciales' && Array.isArray(g.iniciales) && g.iniciales.length) {
      const d = el('div', 'asp-caras');
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', `${g.iniciales.length + (Number(g.mas) || 0)} clientes`);
      const tintas = t.grupo === 'clientes' ? ['#F3E8FF', '#6B21A8'] : ['#EFF6FF', '#1D4ED8'];
      for (const ini of g.iniciales) {
        const s = el('span', null, String(ini).slice(0, 2));
        s.style.background = tintas[0]; s.style.color = tintas[1];
        d.appendChild(s);
      }
      if (Number(g.mas) > 0) d.appendChild(el('span', 'mas', `+${entero(g.mas)}`));
      return d;
    }
    return null;
  }

  function pintarDetalle(t) {
    const d = el('div', 'asp-detalle');
    d.id = `asp-det-${t.id}`;
    if (t.titulo) d.appendChild(el('p', null, t.titulo));
    if (t.explicacion) d.appendChild(el('p', null, t.explicacion));
    const det = t.detalle || {};
    if (Array.isArray(det.numeros) && det.numeros.length) {
      const g = el('div', 'asp-numeros');
      for (const n of det.numeros) {
        const c = el('div');
        c.appendChild(el('span', null, n.etiqueta || ''));
        c.appendChild(el('b', null, valor(n.valor, n.formato)));
        g.appendChild(c);
      }
      d.appendChild(g);
    }
    const tab = det.tabla;
    if (tab && Array.isArray(tab.columnas) && Array.isArray(tab.filas) && tab.filas.length) {
      const env = el('div', 'asp-tabla-env');
      const tabla = el('table', 'asp-tabla');
      const cab = el('tr');
      tab.columnas.forEach((c, i) => { const th = el('th', (tab.formatos || [])[i] && tab.formatos[i] !== 'texto' ? 'n' : null, c); cab.appendChild(th); });
      const thead = el('thead'); thead.appendChild(cab); tabla.appendChild(thead);
      const tbody = el('tbody');
      for (const f of tab.filas) {
        const tr = el('tr');
        (Array.isArray(f) ? f : []).forEach((x, i) => {
          const formato = (tab.formatos || [])[i] || (typeof x === 'number' ? 'entero' : 'texto');
          tr.appendChild(el('td', formato !== 'texto' ? 'n' : null, valor(x, formato)));
        });
        tbody.appendChild(tr);
      }
      tabla.appendChild(tbody);
      env.appendChild(tabla);
      d.appendChild(env);
    }
    if (det.nota) d.appendChild(el('p', 'asp-nota', det.nota));
    const rev = textoRevisar(t.revisar);
    if (rev) d.appendChild(el('p', 'asp-nota', rev));
    if (t.redactadoConIA) d.appendChild(el('p', 'asp-nota', 'El texto lo redactó la IA; los números son los de Xabor.'));
    d.appendChild(boton('asp-callar', 'No avisar de esto', () => opinar(t, 'no_avisar')));
    return d;
  }

  function pintarTarjeta(t) {
    if (E.quitados.has(t.id)) {
      const q = el('div', 'asp-caja asp-vacio', 'Listo: no te volveré a avisar de esto. Si cambias de idea, lo vuelves a encender en Configuración › Asistente.');
      q.setAttribute('role', 'status');
      return q;
    }
    const a = el('article', `asp-caja asp-tarjeta asp-g-${t.grupo || 'ventas'}`);
    a.dataset.aviso = t.id;
    const fila = el('div', 'asp-fila');
    const ic = el('span', 'asp-icono'); ic.appendChild(icono(t.grupo || 'ventas', 20)); fila.appendChild(ic);
    const que = el('div', 'asp-que');
    que.appendChild(el('span', 'asp-etiqueta', t.etiqueta || ''));
    que.appendChild(el('h3', null, t.encabezado));
    fila.appendChild(que);
    if (t.cifra) {
      const c = el('div', 'asp-cifra');
      c.appendChild(el('b', null, t.cifra));
      if (t.sub) c.appendChild(el('span', null, t.sub));
      fila.appendChild(c);
    }
    const g = pintarGrafica(t);
    if (g) fila.appendChild(g);
    a.appendChild(fila);
    // Mejora 2: hasta 3 cifras chicas (el total del negocio, el día o la hora
    // donde se concentra, si es venta nueva o de otro canal).
    if (Array.isArray(t.datos) && t.datos.length) {
      const ul = el('ul', 'asp-datos');
      ul.setAttribute('aria-label', 'Datos del aviso');
      for (const x of t.datos.slice(0, 3)) ul.appendChild(el('li', null, String(x)));
      a.appendChild(ul);
    }

    const acc = el('div', 'asp-accion');
    // Sin recomendación (no hubo datos para una concreta): sin flecha ni texto.
    if (t.sugerencia) acc.appendChild(icono('flecha', 16));
    acc.appendChild(el('span', 'asp-hacer', t.sugerencia || ''));
    // Mejora 1: el botón que abre la pantalla con los datos del aviso.
    if (t.accion && t.accion.etiqueta && ABRIR[t.accion.destino]) {
      const ir = boton('asp-ir', [String(t.accion.etiqueta), icono('flecha', 14)], () => abrirAccion(t));
      ir.dataset.accion = String(t.accion.clave || '');
      acc.appendChild(ir);
    }
    const op = (opinion, nombreIcono, etiqueta) => {
      const b = boton('asp-op', icono(nombreIcono), () => opinar(t, opinion), etiqueta);
      b.setAttribute('aria-pressed', t.opinion === opinion ? 'true' : 'false');
      return b;
    };
    acc.appendChild(op('util', 'util', 'Útil'));
    acc.appendChild(op('no_util', 'noUtil', 'No útil'));
    const abierto = E.abiertos.has(t.id);
    const ver = boton('asp-ver', [t.grupo === 'clientes' ? 'Ver quiénes' : 'Ver números', icono('abajo', 16)], () => {
      if (E.abiertos.has(t.id)) E.abiertos.delete(t.id); else E.abiertos.add(t.id);
      pintar();
    });
    ver.setAttribute('aria-expanded', abierto ? 'true' : 'false');
    ver.setAttribute('aria-controls', `asp-det-${t.id}`);
    acc.appendChild(ver);
    a.appendChild(acc);
    const err = E.errores.get(t.id);
    if (err) { const p = el('p', 'asp-error', err); p.setAttribute('role', 'alert'); a.appendChild(p); }
    if (abierto) a.appendChild(pintarDetalle(t));
    return a;
  }

  async function opinar(t, opinion) {
    E.errores.delete(t.id);
    try {
      const r = await apiFetch(`${RUTA}/avisos/${encodeURIComponent(t.id)}/opinion`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opinion }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || 'No se pudo guardar.');
      t.opinion = opinion;
      if (opinion === 'no_avisar') { E.quitados.add(t.id); E.abiertos.delete(t.id); }
    } catch (e) {
      E.errores.set(t.id, `No se guardó: ${e.message || 'intenta de nuevo'}`);
    }
    pintar();
  }

  // ─── Mejora 1: el botón de cada tarjeta ─────────────────────────────────
  // Solo ABRE una pantalla que ya existe, con los datos del aviso puestos; ahí
  // la persona revisa y confirma. Nada se manda ni se guarda desde aquí, salvo
  // la nota de que se pulsó (para saber qué botones sirven). Las variables que
  // se tocan (HIST, AJ_FECHA, TND) son del panel (index.html).
  const PANTALLAS = { campanas: 'Campañas', menu: 'Menú', productos: 'Reportes › Productos', tienda: 'Promociones', ajustes: 'Correcciones', historial: 'Historial' };
  const fechaValida = (f) => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f);
  const ir = (tab) => { global.bnavTab(tab); return true; };

  const ABRIR = {
    campanas(t, d) {
      const C = global.XaborCampanasWa;
      if (!C || typeof C.prepararDesdeAviso !== 'function') return false;
      C.prepararDesdeAviso(d.segmento
        ? { segmento: d.segmento, nombre: d.nombre, sugerencia: d.sugerencia }
        : { aviso: t.id, cuantos: d.cuantos, nombre: d.nombre, sugerencia: d.sugerencia });
      return ir('campanas');
    },
    menu(t, d) {
      if (Number.isSafeInteger(d.producto) && typeof global.tndEditarEnMenu === 'function') { global.tndEditarEnMenu(d.producto); return true; }
      return ir('menu');
    },
    productos(t, d) {
      const R = global.XaborReportes;
      if (!R || typeof R.preparar !== 'function' || !R.preparar(d)) return false;
      const fd = $('fecha-desde'); const fh = $('fecha-hasta');
      if (fd) fd.value = d.desde;
      if (fh) fh.value = d.hasta;
      global.document.querySelectorAll('.btn-periodo').forEach((b) => b.classList.remove('activo'));
      return ir('productos');
    },
    ajustes(t, d) {
      if (!fechaValida(d.fecha)) return false;
      AJ_FECHA = d.fecha;
      return ir('ajustes');
    },
    historial(t, d) {
      if (!fechaValida(d.desde) || !fechaValida(d.hasta)) return false;
      HIST.periodo = 'rango'; HIST.desde = d.desde; HIST.hasta = d.hasta;
      HIST.filtro = ['todas', 'no_venta'].includes(d.filtro) ? d.filtro : 'todas';
      const hd = $('hist-desde'); const hh = $('hist-hasta');
      if (hd) hd.value = d.desde;
      if (hh) hh.value = d.hasta;
      global.document.querySelectorAll('.hist-periodo').forEach((b) => b.classList.remove('activo'));
      return ir('historial');
    },
    tienda(t, d) {
      if (typeof global.tndEditarPromo !== 'function') return false;
      TND.seccion = 'promociones';
      const viejo = $('tnd-form-promo');
      ir('tienda');
      nuevaPromocion(viejo, d);
      return true;
    },
  };

  // Promociones se pinta cuando llega su lista: se espera el formulario nuevo
  // (no el de una visita anterior), se abre «+ Nueva promoción» y se marcan
  // los días, las categorías o el horario del aviso. Si tarda, se queda en
  // Promociones y la persona la crea a mano.
  async function nuevaPromocion(viejo, d) {
    const hasta = Date.now() + 10000;
    let cont = null;
    while (Date.now() < hasta) {
      const c = $('tnd-form-promo');
      if (c && c !== viejo && c.isConnected) { cont = c; break; }
      await new Promise((r) => global.setTimeout(r, 100));
    }
    if (!cont) return;
    await global.tndEditarPromo(null);
    if (!$('pr-participa')) return;
    const dias = Array.isArray(d.dias) ? d.dias.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6) : [];
    if (dias.length) cont.querySelectorAll('.pr-dia').forEach((x) => { x.checked = dias.includes(Number(x.value)); });
    const cats = Array.isArray(d.categorias) ? d.categorias.filter((x) => Number.isSafeInteger(x)) : [];
    if (cats.length) {
      $('pr-participa').value = 'categorias';
      if (typeof global.tndPromoParticipa === 'function') global.tndPromoParticipa();
      cont.querySelectorAll('.pr-cat').forEach((x) => { x.checked = cats.includes(Number(x.value)); });
    }
    const hora = (h) => typeof h === 'string' && /^\d{2}:\d{2}$/.test(h);
    if (hora(d.horaInicio) && hora(d.horaFin) && $('pr-hini') && $('pr-hfin')) { $('pr-hini').value = d.horaInicio; $('pr-hfin').value = d.horaFin; }
    try { cont.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* sin desplazamiento */ }
  }

  function abrirAccion(t) {
    const a = t.accion || {};
    const destino = a.destino;
    E.errores.delete(t.id);
    const disponible = typeof global.navTabDisponible === 'function' && global.navTabDisponible(destino);
    if (!ABRIR[destino] || !disponible) {
      E.errores.set(t.id, `No tienes acceso a ${PANTALLAS[destino] || 'esa pantalla'} en esta sucursal.`);
      pintar();
      return;
    }
    // La nota de que se pulsó: sin esperarla. Si falla, la pantalla se abre igual.
    try {
      apiFetch(`${RUTA}/avisos/${encodeURIComponent(t.id)}/accion`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: a.clave }),
      }).catch(() => {});
    } catch { /* sin red */ }
    let abierta = false;
    try { abierta = ABRIR[destino](t, a.datos && typeof a.datos === 'object' ? a.datos : {}); } catch { abierta = false; }
    if (!abierta) {
      E.errores.set(t.id, `No se pudo abrir ${PANTALLAS[destino]}. Recarga la página e intenta otra vez.`);
      pintar();
    }
  }

  // ─── La pestaña ─────────────────────────────────────────────────────────
  function pintar() {
    const cont = E.cont;
    if (!cont) return;
    cont.replaceChildren();
    const raiz = el('div', 'asp');
    if (E.cargando && !E.datos) { raiz.appendChild(el('div', 'asp-caja asp-vacio', 'Cargando el asistente…')); cont.appendChild(raiz); return; }
    if (E.error && !E.datos) {
      const v = el('div', 'asp-caja asp-vacio', E.error);
      v.appendChild(boton('asp-reintentar', 'Reintentar', () => cargar()));
      raiz.appendChild(v); cont.appendChild(raiz); return;
    }
    const D = E.datos;
    if (!D || !D.activo) { raiz.appendChild(el('div', 'asp-caja asp-vacio', 'El asistente no está disponible para ti en esta sucursal.')); cont.appendChild(raiz); return; }

    const cab = el('div', 'asp-cabeza');
    cab.appendChild(el('span', 'asp-fecha', fechaLarga(D.comoVa?.hoy || D.revision?.fecha)));
    const chips = el('div', 'asp-chips');
    if (D.revision) {
      const c = el('span', 'asp-chip');
      c.appendChild(icono('reloj', 14));
      c.appendChild(global.document.createTextNode(D.revision.esHoy
        ? `Revisado hoy${D.revision.hora ? ` a las ${D.revision.hora}` : ''}`
        : `Revisado el ${fechaCorta(D.revision.fecha)}${D.revision.hora ? ` a las ${D.revision.hora}` : ''}`));
      chips.appendChild(c);
    }
    if ((D.tarjetas || []).some((t) => t.redactadoConIA)) {
      const c = el('span', 'asp-chip ia');
      c.appendChild(icono('chispa', 14));
      c.appendChild(global.document.createTextNode('Redactado con IA'));
      chips.appendChild(c);
    }
    cab.appendChild(chips);
    raiz.appendChild(cab);

    raiz.appendChild(pintarDia(D.comoVa));

    const tit = el('div', 'asp-titulo');
    tit.appendChild(el('h2', null, !D.revision || D.revision.esHoy ? 'Lo que vi para hoy' : `Lo que vi el ${fechaCorta(D.revision.fecha)}`));
    if (D.revision) {
      tit.appendChild(el('span', 'asp-nota',
        `${entero((D.tarjetas || []).length)} de ${entero(D.revision.candidatos)} cosas revisadas · ${D.orden === 'decision' ? 'primero lo que pide una decisión' : 'las de control van primero'}`));
    }
    raiz.appendChild(tit);

    if (!D.revision) {
      raiz.appendChild(el('div', 'asp-caja asp-vacio', 'Todavía no hay revisión. El asistente revisa las ventas cada mañana, entre las 6:00 y las 12:00.'));
    } else if (!(D.tarjetas || []).length) {
      raiz.appendChild(el('div', 'asp-caja asp-vacio', 'Esta vez no encontré nada fuera de lo normal que pase los mínimos.'));
    } else {
      for (const t of D.tarjetas) raiz.appendChild(pintarTarjeta(t));
    }

    if (D.ia && D.ia.alTope) {
      const p = el('div', 'asp-tope', `La IA llegó a su tope de este mes (US$${D.ia.topeUsd}): los textos son los de Xabor, con los mismos números. Puedes subir el tope en Configuración › Asistente.`);
      p.setAttribute('role', 'status');
      raiz.appendChild(p);
    }
    const pie = [`Solo consulta: el asistente nunca cambia nada. Qué revisa y quién lo ve, en Configuración › Asistente.`];
    if (D.ia && D.ia.encendida && D.ia.gastoMesUsd !== null && D.ia.gastoMesUsd !== undefined) {
      pie.push(`IA este mes: US$${Number(D.ia.gastoMesUsd).toFixed(2)} de US$${D.ia.topeUsd}.`);
    }
    raiz.appendChild(el('p', 'asp-pie', pie.join(' ')));
    cont.appendChild(raiz);
  }

  async function cargar() {
    if (!E.cont || E.cargando) return;
    E.cargando = true; E.error = '';
    if (!E.datos) pintar();
    try {
      const r = await apiFetch(RUTA);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.error) || 'No se pudo leer el asistente.');
      E.datos = d;
      E.errores.clear();
      if (!d || !d.activo) { E.estado = false; E.estadoEn = Date.now(); aplicarEstado(false); }
    } catch (e) {
      E.error = e.message || 'No se pudo leer el asistente.';
      if (E.datos) E.error = '';
    } finally {
      E.cargando = false;
    }
    pintar();
  }

  // Mientras se ve la pestaña, «Cómo va el día» se pone al día solo.
  function programarRefresco() {
    if (E.temporizador) return;
    E.temporizador = global.setInterval(() => {
      if (vistaActiva() !== 'asistente' || global.document.hidden) return;
      cargar();
    }, MINUTOS_REFRESCO * 60000);
  }

  global.XaborAsistentePantalla = {
    // mostrarTab('asistente')
    abrir(cont) {
      if (!cont) return;
      estilos();
      E.cont = cont;
      cargar();
      programarRefresco();
    },
    // Al abrir cualquier pestaña de Reportes: enseña la pestaña solo si el servidor deja.
    revisarPestana,
  };
})(typeof window !== 'undefined' ? window : globalThis);
