// ─── Reportes → Productos, Transacciones y el detalle de Ventas (Fase 3) ────
//
// Pedido de Mario (plan aprobado el 24-nov-2026). Todo depende de la bandera
// `reportes_productos_v1` del negocio: apagada, este archivo no muestra nada y
// Reportes queda exactamente como estaba (Ventas con su tabla de
// Transacciones). Encendida:
//   · Reportes gana las pestañas Productos y Transacciones; la tabla de
//     Transacciones se muda a su pestaña (la misma tabla, los mismos ids).
//   · Ventas gana «Formas de pago y quién vendió», con selector de sucursal.
// El periodo (Hoy / Esta semana / Este mes / fechas) es UNO para las tres
// pestañas: la misma barra se coloca arriba de la pestaña que se ve.
//
// Archivo aparte de index.html por la misma razón que campanas-wa.js: el panel
// es un solo <script> donde una función con nombre repetido pisa en silencio a
// la otra. Lo único global es `XaborReportes`. Botones por delegación de
// eventos, sin onclick en línea.
//
// Habla con /api/reportes/productos y /api/reportes/ventas/detalle
// (src/services/reporteProductosRutas.js, solo administradores con POS).
// «Lo que te diría un consejero» se quitó el 26-nov-2026 por pedido del
// dueño: lo sustituye el asistente con IA (avisos en la campanita).
(function () {
  const E = {
    estado: null, cargandoEstado: null, activo: false, sucursales: [],
    filtro: { periodo: 'hoy' },
    // Productos
    datos: null, error: '', peticion: 0,
    sucursal: 'actual', canal: '', modalidad: '', dia: '', franja: '', minimo: 3,
    vista: 'productos', busca: '', orden: { campo: 'venta', dir: -1 },
    productoMods: '', productoComb: '', categoriaAbierta: '',
    // Revisión del 25-nov-2026: «Por hora» se ordena por venta de entrada, y
    // el detalle del cuadre recuerda si quedó abierto al cambiar un filtro.
    ordenFranja: 'venta', detalleCuadre: false,
    // Ventas → detalle
    detalle: null, detalleError: '', detallePeticion: 0, sucursalVentas: 'actual', rangoVentas: null,
  };

  const $ = (id) => document.getElementById(id);

  // Quien entra directo a #reportes/productos o #reportes/transacciones llega
  // antes de que se lea la bandera, con esas pestañas aún ocultas: el panel le
  // diría «No tienes acceso» y lo mandaría a Inicio. Este archivo corre antes
  // que el arranque del panel, así que la dirección se cambia a Ventas
  // (#reportes) y encender(), ya leída la bandera, lo lleva a donde iba.
  let destinoInicial = { '#reportes/productos': 'productos', '#reportes/transacciones': 'transacciones' }[location.hash] || '';
  if (destinoInicial) { try { history.replaceState(null, '', '#reportes'); } catch { destinoInicial = ''; } }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dinero = (n) => (typeof window.pesosCorte === 'function'
    ? window.pesosCorte(n)
    : `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const num = (n) => Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 2 });
  const pct = (n) => `${Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 1 })} %`;
  // Piezas por ticket: un decimal, «—» si no hay tickets.
  const porTicket = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('es-MX', { maximumFractionDigits: 1 }));
  const normal = (t) => String(t || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

  const VISTAS = [
    ['productos', 'Productos'], ['categorias', 'Categorías'], ['modificadores', 'Opciones'],
    ['combinaciones', 'Combinaciones'], ['sin_movimiento', 'Sin movimiento'], ['por_franja', 'Por hora'],
  ];

  function estilos() {
    if ($('rp-estilos')) return;
    const s = document.createElement('style');
    s.id = 'rp-estilos';
    s.textContent = `
.rp-caja { background:#fff; border:1px solid #e5e2da; border-radius:12px; padding:14px 16px; margin-bottom:12px; }
.rp-filtros { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:12px; }
.rp-filtros label { font-size:0.78rem; color:#666; display:flex; flex-direction:column; gap:2px; }
.rp-filtros select, .rp-filtros input { background:#fff; border:1px solid #e5e2da; border-radius:6px; padding:5px 8px; font-size:0.82rem; color:#1a1a1a; }
.rp-cuadre { display:flex; flex-wrap:wrap; gap:6px 14px; align-items:baseline; font-size:0.88rem; }
.rp-cuadre b { font-weight:800; }
.rp-cuadre .rp-op { color:#999; }
.rp-ok { color:#16a34a; font-weight:700; }
.rp-mal { color:#b91c1c; font-weight:700; }
.rp-nota { font-size:0.78rem; color:#777; margin-top:6px; }
.rp-vistas { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 12px; }
.rp-vistas button, .rp-boton { background:#f8f7f4; border:1px solid #e5e2da; color:#444; border-radius:999px; padding:6px 12px; font-size:0.8rem; font-weight:700; cursor:pointer; }
.rp-vistas button.activa { background:#1c1c1c; color:#fff; border-color:#1c1c1c; }
.rp-tabla-env { overflow-x:auto; }
.rp-tabla { width:100%; border-collapse:collapse; font-size:0.84rem; }
.rp-tabla th { text-align:left; font-size:0.74rem; color:#777; font-weight:700; padding:8px; border-bottom:1px solid #f1f0ed; white-space:nowrap; }
.rp-tabla th[data-orden] { cursor:pointer; }
.rp-tabla td { padding:7px 8px; border-bottom:1px solid #f6f5f2; vertical-align:top; }
.rp-tabla .n { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
.rp-sub { font-size:0.74rem; color:#999; }
.rp-sube { color:#16a34a; } .rp-baja { color:#b91c1c; }
.rp-titulo { font-weight:800; font-size:0.95rem; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
.rp-rejilla { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr)); gap:10px; }
.rp-rejilla > * { min-width:0; }
.rp-rejilla .rp-tabla th { white-space:normal; }
.rp-rejilla .rp-tabla td:not(.n) { overflow-wrap:anywhere; }
.rp-rejilla .rp-tabla-env { overflow-x:auto; }
.rp-comb { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; cursor:pointer; line-height:1.35; }
.rp-comb.abierta { display:block; }
.rp-detalle { margin-top:6px; }
.rp-detalle summary { font-size:0.8rem; color:#555; cursor:pointer; font-weight:700; }
.rp-info { position:relative; display:inline-block; cursor:help; color:#2563eb; font-weight:700; margin-left:3px; }
.rp-info:focus { outline:none; }
.rp-info:hover::after, .rp-info:focus::after { content:attr(data-ayuda); position:absolute; z-index:5; left:0; top:calc(100% + 4px);
  width:260px; max-width:70vw; background:#1c1c1c; color:#fff; font-size:0.74rem; font-weight:400; line-height:1.35;
  padding:8px 10px; border-radius:8px; white-space:normal; text-align:left; }
.rp-tabla .n .rp-info::after { left:auto; right:0; }
.rp-fila-cat { cursor:pointer; }
.rp-fila-cat:hover td { background:#faf9f6; }
tr.rp-reparto-fila > td { background:#faf9f6; padding:10px 8px 10px 24px; }
.rp-reparto-tit { font-size:0.84rem; margin-bottom:6px; overflow-wrap:anywhere; }
.rp-reparto .rp-tabla { max-width:520px; }
.rp-reparto .rp-tabla td { padding:4px 8px; border-bottom:none; background:transparent; }
.rp-reparto .rp-tabla td.rp-barra-celda { width:45%; min-width:60px; vertical-align:middle; }
.rp-barra { display:block; height:10px; border-radius:0 4px 4px 0; background:var(--color-brand, #ea580c); }
.rp-barra.con-tickets { min-width:2px; }
.rp-vacio { color:#aaa; font-size:0.85rem; padding:14px 4px; text-align:center; }
/* Formas de pago y quién vendió (26-nov-2026): las dos tablas lado a lado solo
   si caben; si no, una debajo de la otra. Los nombres se parten por palabras,
   nunca letra por letra, y si la tabla no cabe se desliza y se dice. */
.rp-caja-detalle { container-type:inline-size; }
.rp-detalle-cols { display:grid; grid-template-columns:minmax(0,1fr); gap:18px; }
.rp-detalle-cols > * { min-width:0; }
.rp-detalle-cols > .rp-formas { max-width:640px; }
@container (min-width: 1040px) { .rp-detalle-cols { grid-template-columns:minmax(0,5fr) minmax(0,7fr); } }
.rp-tabla.rp-usuarios th { white-space:normal; }
.rp-usuarios td.rp-nombre { min-width:9em; overflow-wrap:normal; word-break:normal; }
.rp-desliza { font-size:0.78rem; color:#9a3412; margin:4px 0; }
@media (max-width: 600px) { .rp-caja { padding:12px; } .rp-tabla { font-size:0.8rem; } }
`;
    document.head.appendChild(s);
  }

  async function pedir(url) {
    const r = await apiFetch(url);
    const d = await r.json().catch(() => null);
    return { r, d };
  }

  // ─── Encendido ─────────────────────────────────────────────────────────
  function estado() {
    if (E.estado) return Promise.resolve(E.estado);
    if (E.cargandoEstado) return E.cargandoEstado;
    E.cargandoEstado = (async () => {
      try {
        const { r, d } = await pedir('/api/reportes/productos/estado');
        E.estado = r.ok && d ? d : { activo: false, sucursales: [] };
      } catch {
        E.estado = null; // se reintenta la próxima vez
        E.cargandoEstado = null;
        return { activo: false, sucursales: [] };
      }
      E.activo = E.estado.activo === true;
      E.sucursales = Array.isArray(E.estado.sucursales) ? E.estado.sucursales : [];
      if (E.activo) encender();
      return E.estado;
    })();
    return E.cargandoEstado;
  }

  function encender() {
    estilos();
    for (const id of ['pest-productos', 'pest-transacciones']) { const b = $(id); if (b) b.style.display = ''; }
    const trans = $('ventas-transacciones');
    const vistaTrans = $('vista-transacciones');
    if (trans && vistaTrans && trans.parentElement !== vistaTrans) vistaTrans.appendChild(trans);
    const det = $('ventas-detalle');
    if (det) det.hidden = false;
    // La barra de pestañas se vuelve a colocar con los botones nuevos.
    const tab = vistaActiva();
    if (tab && typeof window.navColocarPestanas === 'function') window.navColocarPestanas(tab);
    // Quien entró directo a #reportes/productos o #reportes/transacciones
    // llegó a Ventas mientras se leía la bandera: se le lleva a donde iba
    // (una sola vez, y solo si sigue en Ventas).
    const destino = destinoInicial;
    destinoInicial = '';
    if (destino && tab === 'ventas' && typeof window.bnavTab === 'function') window.bnavTab(destino);
  }

  function vistaActiva() {
    for (const v of ['productos', 'transacciones', 'ventas']) {
      const el = $('vista-' + v);
      if (el && el.style.display === 'block') return v;
    }
    return null;
  }

  // La MISMA barra de periodo va arriba de la pestaña de Reportes que se ve.
  function colocarPeriodo(vista) {
    const per = $('reportes-periodo');
    const v = $('vista-' + vista);
    if (!per || !v) return;
    const barra = v.querySelector(':scope > #pestanas-reportes');
    if (barra) { if (barra.nextElementSibling !== per) barra.after(per); } else if (v.firstElementChild !== per) v.prepend(per);
  }

  function filtroComoParams() {
    const f = E.filtro || { periodo: 'hoy' };
    if (f.periodo) return { periodo: f.periodo };
    return f.hasta ? { desde: f.desde, hasta: f.hasta } : { desde: f.desde };
  }

  // ─── Productos ─────────────────────────────────────────────────────────
  async function cargarProductos() {
    const cont = $('reportes-productos');
    if (!cont) return;
    const peticion = ++E.peticion;
    if (!E.datos) cont.innerHTML = '<div class="rp-caja rp-vacio">Cargando…</div>';
    else cont.style.opacity = '0.6';
    const params = { ...filtroComoParams(), sucursal: E.sucursal, minimo: String(E.minimo) };
    for (const k of ['canal', 'modalidad', 'dia', 'franja']) if (E[k] !== '') params[k] = E[k];
    let datos = null, error = '';
    try {
      const { r, d } = await pedir(`/api/reportes/productos?${new URLSearchParams(params)}`);
      if (!r.ok || !d || !d.cuadre) error = (d && d.error) || 'No se pudo cargar el reporte de productos';
      else datos = d;
    } catch {
      error = 'No se pudo cargar el reporte de productos';
    }
    if (peticion !== E.peticion) return;
    cont.style.opacity = '';
    E.datos = datos; E.error = error;
    if (datos && Array.isArray(datos.sucursales)) E.sucursales = datos.sucursales;
    pintar();
  }

  function opcionesSelect(lista, valor, todos) {
    return [`<option value="">${esc(todos)}</option>`]
      .concat(lista.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(valor) ? ' selected' : ''}>${esc(t)}</option>`))
      .join('');
  }

  function pintarFiltros(d) {
    const disp = (d && d.filtros_disponibles) || { canales: [], modalidades: [], dias: [], franjas: [] };
    const canales = disp.canales.map((c) => [c.clave, c.etiqueta]);
    // Un canal elegido que ya no sale en el periodo se conserva en la lista.
    if (E.canal && !canales.some(([c]) => c === E.canal)) canales.push([E.canal, E.canal]);
    const suc = E.sucursales.length > 1 ? `
      <label>Sucursal<select data-filtro="sucursal">
        ${E.sucursales.map((s) => `<option value="${s.actual ? 'actual' : esc(s.id)}"${(E.sucursal === 'actual' ? s.actual : E.sucursal === s.id) ? ' selected' : ''}>${esc(s.nombre)}${s.actual ? ' (esta)' : ''}</option>`).join('')}
        <option value="todas"${E.sucursal === 'todas' ? ' selected' : ''}>Todas</option>
      </select></label>` : '';
    return `<div class="rp-filtros">${suc}
      <label>Canal<select data-filtro="canal">${opcionesSelect(canales, E.canal, 'Todos')}</select></label>
      <label>Modalidad<select data-filtro="modalidad">${opcionesSelect(disp.modalidades.map((m) => [m.clave, m.etiqueta]), E.modalidad, 'Todas')}</select></label>
      <label>Día<select data-filtro="dia">${opcionesSelect(disp.dias.map((x) => [x.clave, x.etiqueta.charAt(0).toUpperCase() + x.etiqueta.slice(1)]), E.dia, 'Todos')}</select></label>
      <label>Hora<select data-filtro="franja">${opcionesSelect(disp.franjas.map((x) => [x.clave, x.etiqueta]), E.franja, 'Todo el día')}</select></label>
    </div>`;
  }

  // Revisión del 25-nov-2026: «repartido» se explica donde aparece.
  const AYUDA_REPARTIDO = 'Algunas ventas cobran más que la suma del precio de sus productos (por ejemplo, los toppings de Rappi). '
    + 'Esa diferencia se reparte entre los productos de esa misma venta, según lo que vale cada uno, para que la suma cuadre con lo cobrado.';
  const info = (texto) => `<span class="rp-info" tabindex="0" role="note" aria-label="${esc(texto)}" title="${esc(texto)}" data-ayuda="${esc(texto)}">ⓘ</span>`;

  // Contra qué se compara, con la hora cuando el rango incluye hoy.
  function etiquetaComparacion(d) {
    const pa = d.periodo_anterior;
    if (!pa) return 'el periodo anterior';
    return pa.etiqueta_comparacion || pa.etiqueta || 'el periodo anterior';
  }
  const notaHoy = (d) => (d.periodo_anterior?.corte ? ' Hoy todavía no termina: se compara hasta la misma hora.' : '');

  // A la vista, solo la cuenta; lo demás va en «Ver detalle» (revisión del
  // 25-nov-2026). «Sin desglose» sale siempre, aunque sea $0.00; «Otros»,
  // solo si hay (sin él la cuenta no cerraría).
  function pintarCuadre(d) {
    const c = d.cuadre;
    const partes = [`<span>Productos <b>${dinero(c.productos)}</b></span>`];
    if (Number(c.otros)) partes.push(`<span class="rp-op">+</span><span>Otros <b>${dinero(c.otros)}</b></span>`);
    partes.push(`<span class="rp-op">+</span><span>Envíos <b>${dinero(c.envios)}</b></span>`);
    partes.push(`<span class="rp-op">+</span><span>Sin desglose <b>${dinero(c.sin_desglose)}</b></span>`);
    partes.push(`<span class="rp-op">−</span><span>Descuentos <b>${dinero(c.descuentos)}</b></span>`);
    partes.push(`<span class="rp-op">=</span><span>Venta neta <b>${dinero(c.venta_neta)}</b></span>`);
    partes.push(c.cuadra ? '<span class="rp-ok">✓ cuadra</span>' : '<span class="rp-mal">✗ no cuadra</span>');
    const notas = [];
    const varias = d.sucursal === 'todas';
    const ventas = (n) => `${num(n)} ${n === 1 ? 'venta' : 'ventas'}`;
    if (!c.con_filtros && !varias) notas.push(`Es la misma venta neta que ves en la pestaña Ventas para estos días (${ventas(c.tickets)}).`);
    if (c.con_filtros) notas.push(`Cuenta solo las ventas que cumplen los filtros que elegiste (${ventas(c.tickets)}).`);
    if (varias) notas.push(`Suma de ${d.por_sucursal.length} sucursales (${ventas(c.tickets)}); un mismo producto se junta por su nombre.`);
    notas.push('Productos: lo que se vendió de cada producto, antes de descuentos.');
    notas.push(`Envíos: ${dinero(c.envios_cobrados)} cobrados como cargo de envío${Number(c.envios_en_productos) ? ` y ${dinero(c.envios_en_productos)} que se capturaron como un producto de envío (por ejemplo, «ENVIO 60»)` : ''}.`);
    if (Number(c.otros)) notas.push('Otros: lo que se cobró y no es producto ni envío (por ejemplo, bolsas).');
    if (c.sin_registro.ventas) {
      notas.push(`Sin desglose: ${ventas(c.sin_registro.ventas)} (${dinero(c.sin_registro.monto)}) todavía no tienen sus productos separados. Se suman aquí para que el total cuadre; si son de los últimos días, se acomodan solas en unos minutos.`);
    } else if (!Number(c.sin_repartir.monto)) {
      notas.push(`Sin desglose: ${dinero(0)}. Todas las ventas tienen sus productos separados.`);
    }
    if (Number(c.sin_repartir.monto)) notas.push(`Sin desglose: ${dinero(c.sin_repartir.monto)} de ${ventas(c.sin_repartir.ventas)} se cobró aparte y no se pudo repartir entre sus productos.`);
    notas.push('Descuentos: lo que se rebajó en las ventas. Se resta al final porque la venta de cada producto es antes de descuentos.');
    if (Number(c.repartido)) notas.push(`${dinero(c.repartido)} repartido${info(AYUDA_REPARTIDO)}: lo que algunas ventas cobraron aparte del precio de sus productos (por ejemplo, toppings de Rappi). Ya está sumado a los productos de esas mismas ventas.`);
    if (c.lineas_sin_menu.lineas) notas.push(`${num(c.lineas_sin_menu.lineas)} renglones (${dinero(c.lineas_sin_menu.monto)}) se vendieron con un nombre que no está ligado al menú; aparecen en la lista con ese nombre.`);
    const comp = d.comparacion;
    if (d.periodo_anterior) {
      const cambio = comp.cambio_pct === null ? 'sin venta para comparar'
        : `${comp.cambio_pct >= 0 ? '+' : ''}${pct(comp.cambio_pct)}`;
      notas.push(`Productos en ${esc(etiquetaComparacion(d))}: ${dinero(comp.productos)} (${cambio}).${notaHoy(d)}`);
    }
    if (varias) {
      notas.push(d.por_sucursal.map((s) => `${esc(s.negocio.nombre)}: ${dinero(s.venta_neta)} ${s.cuadra ? '✓' : '✗'}`).join(' · '));
    }
    return `<div class="rp-caja" id="rp-cuadre"><div class="rp-cuadre">${partes.join('')}</div>
      <details class="rp-detalle" data-detalle-cuadre${E.detalleCuadre ? ' open' : ''}><summary>Ver detalle</summary>
      ${notas.map((n) => `<div class="rp-nota">${n}</div>`).join('')}</details></div>`;
  }

  function cambioHTML(p) {
    if (p.cambio_pct === null) return Number(p.venta) > 0 ? '<span class="rp-sube">nuevo</span>' : '—';
    const clase = p.cambio_pct > 0 ? 'rp-sube' : (p.cambio_pct < 0 ? 'rp-baja' : '');
    return `<span class="${clase}">${p.cambio_pct > 0 ? '+' : ''}${pct(p.cambio_pct)}</span>`;
  }

  function productosOrdenados(lista) {
    const { campo, dir } = E.orden;
    const q = normal(E.busca).trim();
    const filtrados = q ? lista.filter((p) => normal(`${p.nombre} ${p.categoria}`).includes(q)) : lista.slice();
    const valor = (p) => (campo === 'cambio_pct' ? (p.cambio_pct === null ? -Infinity : p.cambio_pct) : p[campo]);
    return filtrados.sort((a, b) => {
      const x = valor(a), y = valor(b);
      if (typeof x === 'string' || typeof y === 'string') return dir * String(x).localeCompare(String(y), 'es');
      return dir * ((x ?? -Infinity) - (y ?? -Infinity)) || b.venta - a.venta;
    });
  }

  function th(campo, texto, n) {
    const marca = E.orden.campo === campo ? (E.orden.dir < 0 ? ' ▼' : ' ▲') : '';
    return `<th data-orden="${campo}"${n ? ' class="n"' : ''}>${texto}${marca}</th>`;
  }

  function vistaProductos(d) {
    const filas = productosOrdenados(d.productos);
    const varias = d.sucursal === 'todas';
    const cuerpo = filas.length ? filas.map((p) => `<tr>
        <td>${esc(p.nombre)}${p.ligado_al_menu ? '' : ' <span class="rp-sub">(no ligado al menú)</span>'}${varias && p.sucursales ? `<div class="rp-sub">${esc(p.sucursales.join(', '))}</div>` : ''}</td>
        <td>${esc(p.categoria)}</td>
        <td class="n">${num(p.unidades)}</td>
        <td class="n">${dinero(p.venta)}${Number(p.repartido) ? `<div class="rp-sub">incl. ${dinero(p.repartido)} repartido${info(AYUDA_REPARTIDO)}</div>` : ''}</td>
        <td class="n">${pct(p.pct_venta)}</td>
        <td class="n">${p.precio_promedio === null ? '—' : dinero(p.precio_promedio)}</td>
        <td class="n">${num(p.tickets)}</td>
        <td class="n">${porTicket(p.por_ticket)}</td>
        <td class="n">${cambioHTML(p)}<div class="rp-sub">antes ${dinero(p.venta_anterior)}</div></td>
      </tr>`).join('') : `<tr><td colspan="9" class="rp-vacio">${E.busca ? 'Ningún producto coincide con la búsqueda' : 'Sin productos vendidos en este periodo'}</td></tr>`;
    const sinVenta = d.sin_venta_ahora.length ? `<details style="margin-top:10px;"><summary class="rp-sub" style="cursor:pointer;">Se vendieron en ${esc(etiquetaComparacion(d))} y no en este (${d.sin_venta_ahora.length})</summary>
        <div class="rp-tabla-env"><table class="rp-tabla"><tbody>${d.sin_venta_ahora.map((p) => `<tr><td>${esc(p.nombre)}</td><td class="n">${num(p.unidades_anterior)} pzas</td><td class="n">${dinero(p.venta_anterior)}</td></tr>`).join('')}</tbody></table></div></details>` : '';
    return `<div class="rp-caja">
      <div class="rp-titulo"><span>Productos (${d.productos.length})</span>
        <input type="search" data-busca placeholder="Buscar producto o categoría" value="${esc(E.busca)}" style="border:1px solid #e5e2da;border-radius:6px;padding:5px 8px;font-size:0.82rem;min-width:200px;"></div>
      <div class="rp-tabla-env"><table class="rp-tabla"><thead><tr>
        ${th('nombre', 'Producto')}${th('categoria', 'Categoría')}${th('unidades', 'Piezas', true)}${th('venta', 'Venta', true)}
        ${th('pct_venta', '% venta', true)}${th('precio_promedio', 'Precio prom.', true)}${th('tickets', 'Tickets', true)}${th('por_ticket', 'Por ticket', true)}${th('cambio_pct', 'Cambio', true)}
      </tr></thead><tbody>${cuerpo}</tbody></table></div>
      <div class="rp-nota">Venta antes de descuentos. «Por ticket»: cuántas piezas lleva en promedio un ticket que pide ese producto. «Cambio» compara contra ${esc(etiquetaComparacion(d))}.${notaHoy(d)}</div>
      ${sinVenta}</div>`;
  }

  // Cuántas piezas de la categoría lleva cada ticket que la pide: lo típico,
  // el promedio y una fila por tramo (1, 2, 3, 4, 5, 6 a 9, 10 o más) con su
  // barrita. Los números van escritos al lado: la barra solo ayuda a comparar.
  function bloqueReparto(c) {
    const r = c.reparto_por_ticket;
    if (!r || !r.tickets) return '';
    const mayor = Math.max(1, ...r.reparto.map((t) => t.tickets));
    const filas = r.reparto.map((t) => `<tr data-tramo="${esc(t.clave)}" title="${esc(`${t.etiqueta}: ${num(t.tickets)} tickets (${pct(t.pct_tickets)})`)}">
        <td>${esc(t.etiqueta)}</td><td class="n">${num(t.tickets)}</td><td class="n">${pct(t.pct_tickets)}</td>
        <td class="rp-barra-celda"><span class="rp-barra${t.tickets ? ' con-tickets' : ''}" style="width:${Math.round((t.tickets / mayor) * 100)}%"></span></td></tr>`).join('');
    return `<div class="rp-reparto" data-reparto="${esc(c.clave)}">
      <div class="rp-reparto-tit">En ${num(r.tickets)} ${r.tickets === 1 ? 'ticket' : 'tickets'} con ${esc(c.nombre)}: lo típico ${r.tipico === 1 ? 'es' : 'son'} <b data-tipico>${num(r.tipico)}</b> ${r.tipico === 1 ? 'pieza' : 'piezas'} · promedio <b data-promedio>${porTicket(r.promedio)}</b></div>
      <div class="rp-tabla-env"><table class="rp-tabla"><thead><tr><th>Piezas en el ticket</th><th class="n">Tickets</th><th class="n">%</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>
      <div class="rp-nota">«Lo típico» es lo que lleva el ticket de en medio: la mitad de los tickets lleva eso o menos. El promedio lo suben los pedidos grandes (el más grande llevó ${num(r.maximo)}). Una mesa cuenta como un ticket aunque coman varias personas.</div>
    </div>`;
  }

  function vistaCategorias(d) {
    const porClave = new Map(d.productos.map((p) => [p.clave, p]));
    const filas = d.categorias.map((c) => {
      const abierta = E.categoriaAbierta === c.clave;
      const hijos = abierta ? c.productos.map((k) => porClave.get(k)).filter(Boolean).sort((a, b) => b.venta - a.venta)
        .map((p) => `<tr><td style="padding-left:24px;">${esc(p.nombre)}</td><td class="n">${num(p.unidades)}</td><td class="n">${dinero(p.venta)}</td><td class="n">${pct(c.venta ? (p.venta / c.venta) * 100 : 0)} <span class="rp-sub">de la categoría</span></td><td class="n">${num(p.tickets)}</td><td class="n">${porTicket(p.por_ticket)}</td></tr>`).join('') : '';
      const reparto = abierta ? bloqueReparto(c) : '';
      return `<tr class="rp-fila-cat" data-categoria="${esc(c.clave)}"><td>${abierta ? '▾' : '▸'} <b>${esc(c.nombre)}</b> <span class="rp-sub">${c.productos.length} productos</span></td>
        <td class="n">${num(c.unidades)}</td><td class="n">${dinero(c.venta)}</td><td class="n">${pct(c.pct_venta)}</td><td class="n">${num(c.tickets)}</td><td class="n">${porTicket(c.por_ticket)}</td></tr>${hijos}${reparto ? `<tr class="rp-reparto-fila"><td colspan="6">${reparto}</td></tr>` : ''}`;
    }).join('');
    return `<div class="rp-caja"><div class="rp-titulo"><span>Categorías</span></div>
      <div class="rp-tabla-env"><table class="rp-tabla"><thead><tr><th>Categoría</th><th class="n">Piezas</th><th class="n">Venta</th><th class="n">% venta</th><th class="n">Tickets</th><th class="n">Por ticket</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="6" class="rp-vacio">Sin ventas en este periodo</td></tr>'}</tbody></table></div>
      <div class="rp-nota">Toca una categoría para ver sus productos y cuántas piezas lleva cada ticket. «Por ticket»: el promedio de piezas en los tickets que la piden. La categoría es la que el producto tiene hoy en el menú.</div></div>`;
  }

  function selectorProducto(lista, valor, atributo) {
    const vistos = new Map();
    for (const x of lista) if (!vistos.has(x.producto)) vistos.set(x.producto, x.producto_nombre);
    const ops = [...vistos.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
    return `<select ${atributo} style="border:1px solid #e5e2da;border-radius:6px;padding:5px 8px;font-size:0.82rem;">
      <option value="">Todos los productos</option>${ops.map(([k, n]) => `<option value="${esc(k)}"${k === valor ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  }

  function vistaModificadores(d) {
    const grupos = E.productoMods ? d.modificadores.filter((g) => g.producto === E.productoMods) : d.modificadores;
    const tarjetas = grupos.map((g) => `<div class="rp-caja" style="margin:0;">
        <div class="rp-titulo"><span>${esc(g.grupo)} <span class="rp-sub">· ${esc(g.producto_nombre)}</span></span><span class="rp-sub">${num(g.veces)} elecciones</span></div>
        <div class="rp-tabla-env"><table class="rp-tabla"><thead><tr><th>Opción</th><th class="n">Veces</th><th class="n">% del grupo</th><th class="n">Ingreso extra</th></tr></thead><tbody>
        ${g.opciones.map((o) => `<tr><td>${esc(o.opcion)}${Number(o.sin_clasificar) ? ' <span class="rp-sub">(sin emparejar con el menú)</span>' : ''}</td><td class="n">${num(o.veces)}</td><td class="n">${pct(o.pct_grupo)}</td><td class="n">${Number(o.extras) ? dinero(o.extras) : '—'}${o.precio_estimado ? '<div class="rp-sub">estimado</div>' : ''}</td></tr>`).join('')}
        </tbody></table></div></div>`).join('');
    return `<div class="rp-caja"><div class="rp-titulo"><span>Opciones elegidas por grupo</span>${selectorProducto(d.modificadores, E.productoMods, 'data-producto-mods')}</div>
      <div class="rp-nota" style="margin:0 0 10px;">«Ingreso extra» es lo que sumaron las opciones con precio; ya va incluido en la venta de su producto. En Rappi el precio de la opción es el del menú (estimado).</div>
      ${tarjetas ? `<div class="rp-rejilla">${tarjetas}</div>` : '<div class="rp-vacio">Ningún producto vendido con opciones en este periodo</div>'}</div>`;
  }

  function vistaCombinaciones(d) {
    const lista = E.productoComb ? d.combinaciones.filter((c) => c.producto === E.productoComb) : d.combinaciones;
    const bloques = lista.map((c) => `<div class="rp-caja" style="margin:0;">
        <div class="rp-titulo"><span>${esc(c.producto_nombre)}</span><span class="rp-sub">${num(c.veces)} vendidos · ${num(c.distintas)} combinaciones distintas${Number(c.sin_opciones) ? ` · ${num(c.sin_opciones)} sin opciones` : ''}</span></div>
        <div class="rp-tabla-env"><table class="rp-tabla"><thead><tr><th>#</th><th>Combinación</th><th class="n">Veces</th><th class="n">%</th></tr></thead><tbody>
        ${c.combinaciones.map((x, i) => `<tr><td>${i + 1}</td><td><div class="rp-comb" data-comb title="${esc(x.opciones)}">${esc(x.opciones)}</div></td><td class="n">${num(x.veces)}</td><td class="n">${pct(x.pct)}</td></tr>`).join('')}
        </tbody></table></div></div>`).join('');
    const pares = d.pares.length ? d.pares.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.productos[0].nombre)} <span class="rp-sub">+</span> ${esc(p.productos[1].nombre)}</td><td class="n">${num(p.tickets)}</td><td class="n">${pct(p.pct_tickets)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="rp-vacio">Ningún ticket con dos productos distintos</td></tr>';
    return `<div class="rp-caja"><div class="rp-titulo"><span>Las 10 combinaciones más pedidas por platillo</span>${selectorProducto(d.combinaciones, E.productoComb, 'data-producto-comb')}</div>
      ${bloques ? `<div class="rp-rejilla">${bloques}</div>` : '<div class="rp-vacio">Ningún platillo con opciones en este periodo</div>'}</div>
      <div class="rp-caja"><div class="rp-titulo"><span>Productos que más se venden juntos</span><span class="rp-sub">en el mismo ticket</span></div>
      <div class="rp-tabla-env"><table class="rp-tabla"><thead><tr><th>#</th><th>Par</th><th class="n">Tickets</th><th class="n">% de los tickets</th></tr></thead><tbody>${pares}</tbody></table></div></div>`;
  }

  const MOTIVO_INACTIVO = {
    sin_menu: 'no está ligado al menú', no_disponible: 'está marcado como no disponible',
    categoria_oculta: 'su categoría está oculta', no_es_producto: 'no está marcado como producto',
  };

  // Los conteos se explican en pantalla (revisión del 25-nov-2026):
  //   activos = los que vendieron algo + los que no vendieron nada, y
  //   productos vendidos = activos que vendieron algo + los que hoy ya no están activos.
  function notaConteos(d) {
    const s = d.sin_movimiento;
    if (s.activos_con_venta === undefined) return '';
    const enCero = s.productos.filter((p) => Number(p.unidades) === 0).length;
    const pocos = s.productos.length - enCero;
    const partes = [`De los ${num(s.activos)} productos activos, ${num(s.activos_con_venta)} vendieron algo y ${num(s.activos_sin_venta)} no vendieron nada.`];
    if (s.productos.length) {
      partes.push(`Aquí salen los que vendieron menos de ${num(s.minimo)} piezas: ${num(enCero)} sin ninguna venta${pocos ? ` y ${num(pocos)} con 1 a ${num(s.minimo - 1)}` : ''}.`);
    }
    const no = s.vendidos_no_activos || [];
    if (no.length) {
      const muestra = no.slice(0, 5).map((p) => `${esc(p.nombre)} (${MOTIVO_INACTIVO[p.motivo] || 'ya no está activo'})`).join(', ');
      partes.push(`La lista de Productos tiene ${num(d.productos.length)}: los ${num(s.activos_con_venta)} activos que vendieron y ${num(no.length)} que se ${no.length === 1 ? 'vendió' : 'vendieron'} pero hoy ya no ${no.length === 1 ? 'está activo' : 'están activos'}: ${muestra}${no.length > 5 ? ` y ${num(no.length - 5)} más` : ''}.`);
    }
    return partes.join(' ');
  }

  function vistaSinMovimiento(d) {
    const s = d.sin_movimiento;
    const filas = s.productos.length ? s.productos.map((p) => `<tr><td>${esc(p.nombre)}${p.sucursales ? `<div class="rp-sub">${esc(p.sucursales.join(', '))}</div>` : ''}</td><td>${esc(p.categoria)}</td><td class="n">${num(p.unidades)}</td><td class="n">${dinero(p.venta)}</td><td class="n">${num(p.tickets)}</td></tr>`).join('')
      : `<tr><td colspan="5" class="rp-vacio">Todos los productos activos vendieron ${num(s.minimo)} piezas o más</td></tr>`;
    const conteos = notaConteos(d);
    return `<div class="rp-caja"><div class="rp-titulo"><span>Sin movimiento: ${s.productos.length} de ${s.activos} productos activos</span>
      <label class="rp-sub" style="display:flex;align-items:center;gap:6px;">Menos de <input type="number" min="1" max="1000" step="1" data-minimo value="${esc(s.minimo)}" style="width:70px;border:1px solid #e5e2da;border-radius:6px;padding:4px 6px;"> piezas</label></div>
      <div class="rp-tabla-env"><table class="rp-tabla"><thead><tr><th>Producto</th><th>Categoría</th><th class="n">Piezas</th><th class="n">Venta</th><th class="n">Tickets</th></tr></thead><tbody>${filas}</tbody></table></div>
      <div class="rp-nota">Activos: productos disponibles hoy en el menú, en una categoría visible. No cuenta los envíos.</div>
      ${conteos ? `<div class="rp-nota" data-conteos>${conteos}</div>` : ''}</div>`;
  }

  // La lista de una franja en el orden elegido (la misma para la pantalla y el CSV).
  const productosDeFranja = (f) => (E.ordenFranja === 'piezas' && Array.isArray(f.productos_por_piezas) ? f.productos_por_piezas : f.productos);

  function vistaPorFranja(d) {
    const tarjetas = d.por_franja.map((f) => {
      const lista = productosDeFranja(f);
      return `<div class="rp-caja" style="margin:0;">
        <div class="rp-titulo"><span>${esc(f.etiqueta)}${f.franja === 'otras' ? '' : ' h'}</span><span class="rp-sub">${num(f.tickets)} tickets · ${dinero(f.venta)}</span></div>
        ${lista.length ? `<div class="rp-tabla-env"><table class="rp-tabla"><tbody>${lista.map((p, i) => `<tr><td>${i + 1}. ${esc(p.nombre)}</td><td class="n">${num(p.unidades)} pzas</td><td class="n">${dinero(p.venta)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="rp-vacio">Sin ventas</div>'}
      </div>`;
    }).join('');
    const sel = (v, t) => `<option value="${v}"${E.ordenFranja === v ? ' selected' : ''}>${t}</option>`;
    return `<div class="rp-caja"><div class="rp-titulo"><span>Los 5 más vendidos por franja horaria</span>
      <label class="rp-sub" style="display:flex;align-items:center;gap:6px;">Ordenar por
        <select data-orden-franja style="border:1px solid #e5e2da;border-radius:6px;padding:4px 6px;font-size:0.82rem;">${sel('venta', 'Venta')}${sel('piezas', 'Piezas')}</select></label></div>
      <div class="rp-rejilla">${tarjetas}</div>
      <div class="rp-nota">Hora del negocio. ${E.ordenFranja === 'piezas' ? 'Ordenados por piezas vendidas.' : 'Ordenados por venta (antes de descuentos).'}</div></div>`;
  }

  function pintar() {
    const cont = $('reportes-productos');
    if (!cont) return;
    const d = E.datos;
    if (!d) {
      cont.innerHTML = `${pintarFiltros(null)}<div class="rp-caja" style="color:#b91c1c;">${esc(E.error || 'Sin datos')}</div>`;
      return;
    }
    const cuerpo = {
      productos: vistaProductos, categorias: vistaCategorias, modificadores: vistaModificadores,
      combinaciones: vistaCombinaciones, sin_movimiento: vistaSinMovimiento, por_franja: vistaPorFranja,
    }[E.vista](d);
    const enfocado = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute('data-busca');
    cont.innerHTML = `${pintarFiltros(d)}${pintarCuadre(d)}
      <nav class="rp-vistas" aria-label="Vistas del reporte de productos">
        ${VISTAS.map(([v, t]) => `<button type="button" data-vista="${v}" class="${v === E.vista ? 'activa' : ''}">${t}</button>`).join('')}
        <button type="button" class="rp-boton" data-csv style="margin-left:auto;">⬇️ CSV de esta vista</button>
      </nav>${cuerpo}`;
    if (enfocado) {
      const b = cont.querySelector('[data-busca]');
      if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); }
    }
  }

  // ─── CSV ───────────────────────────────────────────────────────────────
  // Los tramos de «por ticket» los manda el servidor; esta lista solo pone el
  // encabezado cuando no hay ninguna categoría.
  const TRAMOS_PANEL = ['1', '2', '3', '4', '5', '6 a 9', '10 o más'];
  // Un monto sale SIEMPRE con dos decimales (2725 → «2725.00»), también si es
  // negativo; por eso va envuelto y no pasa por el filtro de fórmulas.
  const monto = (n) => ({ monto: Number(n) || 0 });
  function celdaCSV(c) {
    if (c && typeof c === 'object' && 'monto' in c) return (Math.round(c.monto * 100) / 100).toFixed(2);
    const t = String(c ?? '');
    return typeof c !== 'number' && /^[=+\-@]/.test(t) ? `'${t}` : t;
  }
  function descargarCSV(nombre, filas) {
    const csv = filas.map((r) => r.map((c) => `"${celdaCSV(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function filasCSV(d, vista) {
    switch (vista) {
      case 'productos': return [['Producto', 'Categoria', 'Ligado al menu', 'Piezas', 'Venta', '% de la venta', 'Precio promedio', 'Tickets', 'Por ticket', 'Repartido (toppings)', 'Piezas periodo anterior', 'Venta periodo anterior', 'Cambio %', `Compara contra: ${etiquetaComparacion(d)}`]]
        .concat(productosOrdenados(d.productos).map((p) => [p.nombre, p.categoria, p.ligado_al_menu ? 'si' : 'no', p.unidades, monto(p.venta), p.pct_venta, p.precio_promedio === null ? '' : monto(p.precio_promedio), p.tickets, p.por_ticket ?? '', monto(p.repartido), p.unidades_anterior, monto(p.venta_anterior), p.cambio_pct ?? '', '']));
      case 'categorias': {
        const tramos = d.categorias[0]?.reparto_por_ticket?.reparto?.map((t) => t.etiqueta) || TRAMOS_PANEL;
        return [['Categoria', 'Piezas', 'Venta', '% de la venta', 'Tickets', 'Productos', 'Por ticket', 'Tipico (mediana)', ...tramos.map((e) => `Tickets con ${String(e).replace(/á/g, 'a')}`)]]
          .concat(d.categorias.map((c) => [c.nombre, c.unidades, monto(c.venta), c.pct_venta, c.tickets, c.productos.length,
            c.por_ticket ?? '', c.reparto_por_ticket?.tipico ?? '', ...(c.reparto_por_ticket?.reparto || []).map((t) => t.tickets)]));
      }
      case 'modificadores': return [['Producto', 'Grupo', 'Opcion', 'Veces', '% del grupo', 'Ingreso extra', 'Precio estimado', 'Sin emparejar']]
        .concat((E.productoMods ? d.modificadores.filter((g) => g.producto === E.productoMods) : d.modificadores)
          .flatMap((g) => g.opciones.map((o) => [g.producto_nombre, g.grupo, o.opcion, o.veces, o.pct_grupo, monto(o.extras), o.precio_estimado ? 'si' : 'no', o.sin_clasificar])));
      case 'combinaciones': return [['Tipo', 'Producto', 'Combinacion o par', 'Veces o tickets', '%']]
        .concat((E.productoComb ? d.combinaciones.filter((c) => c.producto === E.productoComb) : d.combinaciones)
          .flatMap((c) => c.combinaciones.map((x) => ['combinacion', c.producto_nombre, x.opciones, x.veces, x.pct])))
        .concat(d.pares.map((p) => ['par en el mismo ticket', '', `${p.productos[0].nombre} + ${p.productos[1].nombre}`, p.tickets, p.pct_tickets]));
      case 'sin_movimiento': return [['Producto', 'Categoria', 'Piezas', 'Venta', 'Tickets', `Minimo: ${d.sin_movimiento.minimo}`, `Activos: ${d.sin_movimiento.activos}`]]
        .concat(d.sin_movimiento.productos.map((p) => [p.nombre, p.categoria, p.unidades, monto(p.venta), p.tickets, '', '']));
      case 'por_franja': return [['Franja', 'Lugar', 'Producto', 'Piezas', 'Venta', 'Tickets de la franja', `Ordenado por: ${E.ordenFranja === 'piezas' ? 'piezas' : 'venta'}`]]
        .concat(d.por_franja.flatMap((f) => productosDeFranja(f).map((p, i) => [f.etiqueta, i + 1, p.nombre, p.unidades, monto(p.venta), f.tickets, ''])));
      default: return [];
    }
  }

  // ─── Eventos de Productos ──────────────────────────────────────────────
  function enlazarProductos() {
    const cont = $('reportes-productos');
    if (!cont || cont.dataset.enlazado) return;
    cont.dataset.enlazado = '1';
    cont.addEventListener('change', (ev) => {
      const el = ev.target;
      const filtro = el.getAttribute('data-filtro');
      if (filtro) {
        E[filtro] = el.value || (filtro === 'sucursal' ? 'actual' : '');
        // Con otra sucursal los productos se identifican distinto: la
        // elección de producto en Opciones y Combinaciones ya no aplica.
        if (filtro === 'sucursal') { E.productoMods = ''; E.productoComb = ''; E.categoriaAbierta = ''; }
        cargarProductos(); return;
      }
      if (el.hasAttribute('data-producto-mods')) { E.productoMods = el.value; pintar(); return; }
      if (el.hasAttribute('data-producto-comb')) { E.productoComb = el.value; pintar(); return; }
      if (el.hasAttribute('data-orden-franja')) { E.ordenFranja = el.value === 'piezas' ? 'piezas' : 'venta'; pintar(); return; }
      if (el.hasAttribute('data-minimo')) {
        const n = Math.trunc(Number(el.value));
        if (Number.isFinite(n) && n >= 1 && n <= 1000 && n !== E.minimo) { E.minimo = n; cargarProductos(); }
      }
    });
    cont.addEventListener('input', (ev) => {
      if (ev.target.hasAttribute('data-busca')) { E.busca = ev.target.value; pintar(); }
    });
    // «toggle» no sube por el árbol: se escucha en la fase de captura.
    cont.addEventListener('toggle', (ev) => {
      if (ev.target.hasAttribute && ev.target.hasAttribute('data-detalle-cuadre')) E.detalleCuadre = ev.target.open;
    }, true);
    cont.addEventListener('click', (ev) => {
      const comb = ev.target.closest('[data-comb]');
      if (comb) { comb.classList.toggle('abierta'); return; }
      const vista = ev.target.closest('[data-vista]');
      if (vista) { E.vista = vista.getAttribute('data-vista'); pintar(); return; }
      const orden = ev.target.closest('[data-orden]');
      if (orden) {
        const campo = orden.getAttribute('data-orden');
        E.orden = E.orden.campo === campo ? { campo, dir: -E.orden.dir } : { campo, dir: ['nombre', 'categoria'].includes(campo) ? 1 : -1 };
        pintar(); return;
      }
      const cat = ev.target.closest('[data-categoria]');
      if (cat) { const k = cat.getAttribute('data-categoria'); E.categoriaAbierta = E.categoriaAbierta === k ? '' : k; pintar(); return; }
      if (ev.target.closest('[data-csv]') && E.datos) {
        const r = E.datos.rango || {};
        descargarCSV(`productos-${E.vista}-${r.desde || ''}_${r.hasta || ''}.csv`, filasCSV(E.datos, E.vista));
      }
    });
  }

  // ─── Ventas: formas de pago, quién vendió y sucursales ─────────────────
  async function cargarDetalle() {
    const cont = $('ventas-detalle');
    const r = E.rangoVentas;
    if (!cont || !r) return;
    estilos();
    enlazarDetalle();
    const peticion = ++E.detallePeticion;
    cont.style.opacity = E.detalle ? '0.6' : '';
    let d = null, error = '';
    try {
      const res = await pedir(`/api/reportes/ventas/detalle?${new URLSearchParams({ desde: r.desde, hasta: r.hasta, sucursal: E.sucursalVentas })}`);
      if (!res.r.ok || !res.d || !Array.isArray(res.d.detalles)) error = (res.d && res.d.error) || 'No se pudo cargar el detalle de ventas';
      else d = res.d;
    } catch {
      error = 'No se pudo cargar el detalle de ventas';
    }
    if (peticion !== E.detallePeticion) return;
    cont.style.opacity = '';
    E.detalle = d; E.detalleError = error;
    if (d && Array.isArray(d.sucursales)) E.sucursales = d.sucursales;
    pintarDetalle();
  }

  function selectorSucursalVentas() {
    if (E.sucursales.length < 2) return '';
    return `<label class="rp-sub" style="display:flex;align-items:center;gap:6px;">Sucursal
      <select data-sucursal-ventas style="border:1px solid #e5e2da;border-radius:6px;padding:5px 8px;font-size:0.82rem;">
        ${E.sucursales.map((s) => `<option value="${s.actual ? 'actual' : esc(s.id)}"${(E.sucursalVentas === 'actual' ? s.actual : E.sucursalVentas === s.id) ? ' selected' : ''}>${esc(s.nombre)}${s.actual ? ' (esta)' : ''}</option>`).join('')}
        <option value="todas"${E.sucursalVentas === 'todas' ? ' selected' : ''}>Todas, lado a lado</option>
      </select></label>`;
  }

  function tablaFormas(fp) {
    if (!fp.clases.length) return '<div class="rp-vacio">Sin ventas</div>';
    return `<table class="rp-tabla"><thead><tr><th>Forma de pago</th><th class="n">Pedidos</th><th class="n">Venta</th><th class="n">%</th></tr></thead><tbody>
      ${fp.clases.map((c) => `<tr><td>${esc(c.etiqueta)}</td><td class="n">${num(c.pedidos)}</td><td class="n">${dinero(c.venta)}</td><td class="n">${pct(c.pct_venta)}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td class="n"><b>${num(fp.tickets)}</b></td><td class="n"><b>${dinero(fp.venta_neta)}</b></td><td></td></tr>
      </tbody></table>
      ${fp.cobros_mixtos ? `<div class="rp-nota">${num(fp.cobros_mixtos)} cobros mixtos repartidos entre sus formas de pago (por eso los pedidos suman más que el total).</div>` : ''}
      <details style="margin-top:6px;"><summary class="rp-sub" style="cursor:pointer;">Como se escribió cada forma de pago</summary>
      <table class="rp-tabla"><tbody>${fp.detalle.map((x) => `<tr><td>${esc(x.forma)}</td><td class="rp-sub">${esc(x.etiqueta_clase)}</td><td class="n">${num(x.pedidos)}</td><td class="n">${dinero(x.venta)}</td></tr>`).join('')}</tbody></table></details>`;
  }

  // Un nombre dado de alta TODO EN MAYÚSCULAS se muestra como «Mario Alberto
  // Cantu Ochoa». Solo cómo se ve: el dato no cambia, y un nombre que ya trae
  // minúsculas se deja como está.
  const MINUSCULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
  function nombrePersona(s) {
    const t = String(s ?? '').trim();
    if (!t || /\p{Ll}/u.test(t)) return t;
    return t.toLocaleLowerCase('es-MX').split(/(\s+)/).map((p, i) => (/^\s+$/.test(p) || (i > 0 && MINUSCULAS.has(p)) ? p
      : p.replace(/(^|[-'])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('es-MX')))).join('');
  }

  function tablaUsuarios(u) {
    const filas = u.usuarios.map((x) => `<tr><td class="rp-nombre">${esc(nombrePersona(x.nombre))}</td><td class="n">${num(x.atendidas.tickets)}</td><td class="n">${dinero(x.atendidas.venta)}</td><td class="n">${pct(x.atendidas.pct_venta)}</td><td class="n">${num(x.cerradas.tickets)}</td><td class="n">${dinero(x.cerradas.venta)}</td></tr>`).join('');
    return `<div class="rp-desliza" data-desliza-usuarios hidden>La tabla sigue a la derecha: deslízala para ver todas las columnas →</div>
      <div class="rp-tabla-env" data-env-usuarios><table class="rp-tabla rp-usuarios"><thead><tr><th>Usuario</th><th class="n">Mesas atendidas</th><th class="n">Venta</th><th class="n">%</th><th class="n">Cuentas que cerró</th><th class="n">Monto de esas cuentas</th></tr></thead><tbody>
      ${filas}
      <tr><td class="rp-nombre">Sin registrar</td><td class="n">${num(u.sin_registrar.tickets)}</td><td class="n">${dinero(u.sin_registrar.venta)}</td><td class="n">${pct(u.sin_registrar.pct_venta)}</td><td></td><td></td></tr>
      </tbody></table></div>
      <div class="rp-nota">Sin registrar: el mostrador, WhatsApp, la tienda y Rappi aún no guardan quién vendió.</div>`;
  }

  // Si la tabla de usuarios no cabe (celular), se desliza y se dice.
  function revisarDeslizaUsuarios() {
    const cont = $('ventas-detalle');
    if (!cont) return;
    const env = cont.querySelector('[data-env-usuarios]');
    const aviso = cont.querySelector('[data-desliza-usuarios]');
    if (!env || !aviso) return;
    aviso.hidden = !(env.clientWidth > 0 && env.scrollWidth > env.clientWidth + 1);
  }

  function pintarDetalle() {
    const cont = $('ventas-detalle');
    if (!cont) return;
    const d = E.detalle;
    const cab = `<div class="rp-titulo"><span>Formas de pago y quién vendió</span>${selectorSucursalVentas()}</div>`;
    if (!d) { cont.innerHTML = `<div class="rp-caja">${cab}<div style="color:#b91c1c;font-size:0.85rem;">${esc(E.detalleError || 'Sin datos')}</div></div>`; return; }
    if (d.detalles.length > 1) {
      const s = d.detalles;
      const col = (f) => s.map((x) => `<td class="n">${f(x)}</td>`).join('');
      const clases = [];
      for (const x of s) for (const c of x.por_forma_pago.clases) if (!clases.some((k) => k.clase === c.clase)) clases.push({ clase: c.clase, etiqueta: c.etiqueta });
      const deClase = (x, clase) => x.por_forma_pago.clases.find((c) => c.clase === clase) || { venta: 0 };
      const totClase = (clase) => (d.total.por_forma_pago.find((c) => c.clase === clase) || { venta: 0 }).venta;
      cont.innerHTML = `<div class="rp-caja">${cab}<div class="rp-tabla-env"><table class="rp-tabla">
        <thead><tr><th></th>${s.map((x) => `<th class="n">${esc(x.negocio.nombre)}</th>`).join('')}<th class="n">Todas</th></tr></thead><tbody>
        <tr><td><b>Venta neta</b></td>${col((x) => `<b>${dinero(x.desglose.venta_neta)}</b>`)}<td class="n"><b>${dinero(d.total.venta_neta)}</b></td></tr>
        <tr><td>Pedidos</td>${col((x) => num(x.resumen.num_pedidos))}<td class="n">${num(d.total.num_pedidos)}</td></tr>
        <tr><td>Ticket promedio</td>${col((x) => dinero(x.resumen.promedio))}<td class="n">${dinero(d.total.promedio)}</td></tr>
        <tr><td>Venta bruta</td>${col((x) => dinero(x.desglose.venta_bruta))}<td class="n">${dinero(d.total.venta_bruta)}</td></tr>
        <tr><td>Descuentos</td>${col((x) => dinero(x.desglose.descuentos))}<td class="n">${dinero(d.total.descuentos)}</td></tr>
        <tr><td>Envíos cobrados</td>${col((x) => dinero(x.desglose.envios_cobrados))}<td class="n">${dinero(d.total.envios_cobrados)}</td></tr>
        ${clases.map((c) => `<tr><td>${esc(c.etiqueta)}</td>${col((x) => dinero(deClase(x, c.clase).venta))}<td class="n">${dinero(totClase(c.clase))}</td></tr>`).join('')}
        <tr><td>Mesas: venta con mesero</td>${col((x) => dinero(x.por_usuario.usuarios.reduce((a, u) => a + Number(u.atendidas.venta || 0), 0)))}<td></td></tr>
        </tbody></table></div>
        <div class="rp-nota">Cada columna es la pestaña Ventas de esa sucursal para los mismos días. Las tarjetas de arriba son solo de la sucursal en la que estás.</div></div>`;
      return;
    }
    const x = d.detalles[0];
    const otra = !E.sucursales.find((s) => s.id === x.negocio.id)?.actual;
    cont.innerHTML = `<div class="rp-caja rp-caja-detalle">${cab}
      ${otra ? `<div class="rp-nota" style="margin:0 0 8px;">${esc(x.negocio.nombre)}: venta neta ${dinero(x.desglose.venta_neta)} en ${num(x.resumen.num_pedidos)} pedidos. Las tarjetas de arriba son de la sucursal en la que estás.</div>` : ''}
      <div class="rp-detalle-cols"><div class="rp-formas">${tablaFormas(x.por_forma_pago)}</div><div>${tablaUsuarios(x.por_usuario)}</div></div></div>`;
    revisarDeslizaUsuarios();
    requestAnimationFrame(revisarDeslizaUsuarios);
  }

  function enlazarDetalle() {
    const cont = $('ventas-detalle');
    if (!cont || cont.dataset.enlazado) return;
    cont.dataset.enlazado = '1';
    window.addEventListener('resize', revisarDeslizaUsuarios);
    cont.addEventListener('change', (ev) => {
      if (ev.target.hasAttribute('data-sucursal-ventas')) { E.sucursalVentas = ev.target.value || 'actual'; cargarDetalle(); }
    });
  }

  // ─── Lo que llama index.html ───────────────────────────────────────────
  window.XaborReportes = {
    // mostrarTab('productos' | 'transacciones').
    async abrir(vista) {
      await estado();
      if (!E.activo) return;
      colocarPeriodo(vista);
      if (vista === 'productos') { estilos(); enlazarProductos(); cargarProductos(); }
      if (vista === 'transacciones' && typeof window.cargarVentas === 'function') window.cargarVentas(filtroComoParams());
    },
    // Asistente, Mejora 1: lo llama panel/asistente-pantalla.js ANTES de abrir
    // Productos, para que abra en las fechas, la vista y el filtro del aviso.
    // Los demás filtros vuelven a «todos» para que se vea lo mismo que vio él.
    preparar(p) {
      const x = p && typeof p === 'object' ? p : {};
      const fecha = (f) => (typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : '');
      const desde = fecha(x.desde); const hasta = fecha(x.hasta);
      if (!desde || !hasta) return false;
      E.filtro = { desde, hasta };
      E.vista = VISTAS.some(([v]) => v === x.vista) ? x.vista : 'productos';
      E.sucursal = 'actual'; E.modalidad = ''; E.dia = ''; E.franja = ''; E.busca = '';
      E.canal = typeof x.canal === 'string' && /^[a-z][a-z0-9_:]{0,39}$/.test(x.canal) ? x.canal : '';
      E.categoriaAbierta = typeof x.categoria === 'string' && /^c:\d{1,12}$/.test(x.categoria) ? x.categoria : '';
      E.productoMods = ''; E.productoComb = '';
      return true;
    },
    // setPeriodo / setPeriodoCustom. true = ya lo atendió aquí (Productos).
    cambiarPeriodo(filtro) {
      if (filtro && typeof filtro === 'object') E.filtro = { ...filtro };
      if (!E.activo) return false;
      const vista = vistaActiva();
      if (vista) colocarPeriodo(vista);
      if (vista === 'productos') { cargarProductos(); return true; }
      return false;
    },
    // cargarVentas, al terminar: el detalle de Ventas usa los mismos días.
    alCargarVentas(reporte) {
      E.rangoVentas = reporte && reporte.rango ? { desde: reporte.rango.desde, hasta: reporte.rango.hasta } : null;
      estado().then(() => {
        if (E.activo && vistaActiva() === 'ventas' && E.rangoVentas) cargarDetalle();
      });
    },
  };
})();
