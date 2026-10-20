// ─── Configuración → «Diseño de ticket y comanda» ───────────────────────────
//
// El dueño elige cómo se ve el papel de cocina y el ticket del cliente, con
// una vista previa a escala que pide al servidor los MISMOS renglones que
// imprime el Edge (/api/impresion/formato/vista-previa). Cada cambio se
// guarda solo. Nada aquí decide el papel: solo muestra y guarda opciones.
//
// Vive en su propio archivo (y no dentro de index.html) para tocar lo menos
// posible el panel. index.html lo carga con ?v=<huella> y lo abre con
// XaborDisenoPapel.abrir(contenedor) desde cfgIr('diseno').
(function () {
  'use strict';

  const pedir = (url, opts = {}) => (typeof window.apiFetch === 'function'
    ? window.apiFetch(url, opts)
    : fetch(url, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } }));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Opciones, en palabras del restaurante. `clave` es la del formato v1
  // (src/printing/formato/opciones.js); el servidor valida todo otra vez.
  const OPCIONES = {
    comanda: [
      { titulo: 'Platillos' },
      { clave: 'producto', tipo: 'opciones', titulo: 'Tamaño del platillo',
        ayuda: 'Automático usa la letra más grande que cabe sin partir el nombre.',
        valores: [['auto', 'Automático'], ['doble', 'Extra grande'], ['alto', 'Grande'], ['normal', 'Normal']] },
      { clave: 'modificadores', tipo: 'opciones', titulo: 'Tamaño de las opciones (salsa, proteína…)',
        valores: [['alto', 'Grande'], ['normal', 'Normal']] },
      { clave: 'aire', tipo: 'opciones', titulo: 'Espacio entre letras de las opciones',
        ayuda: 'Automático deja espacio cuando el papel es ancho.',
        valores: [['auto', 'Automático'], [0, 'Sin espacio'], [1, 'Poco'], [2, 'Más']] },
      { clave: 'mostrarGrupo', tipo: 'si', titulo: 'Mostrar el nombre de cada grupo', ayuda: '«Salsa: Verde» en lugar de solo «Verde».' },
      { clave: 'notaInvertida', tipo: 'si', titulo: 'Resaltar las notas en blanco sobre negro' },
      { titulo: 'Encabezado' },
      { clave: 'tamOrden', tipo: 'opciones', titulo: 'Número de orden o mesa', valores: [['doble', 'Extra grande'], ['alto', 'Grande']] },
      { clave: 'negocio', tipo: 'si', titulo: 'Nombre del negocio' },
      { clave: 'cliente', tipo: 'si', titulo: 'Nombre del cliente' },
      { clave: 'mesero', tipo: 'si', titulo: 'Mesero' },
      { clave: 'impresora', tipo: 'si', titulo: 'Estación (Cocina, Bebidas…)' },
    ],
    ticket: [
      { titulo: 'Encabezado', ayuda: 'Los datos salen de Configuración → Negocio. Si un dato no está capturado, no aparece.' },
      { clave: 'negocio', tipo: 'si', titulo: 'Nombre del negocio', dato: 'nombre' },
      { clave: 'direccion', tipo: 'si', titulo: 'Dirección', dato: 'direccion' },
      { clave: 'rfc', tipo: 'si', titulo: 'RFC', dato: 'rfc' },
      { clave: 'telefono', tipo: 'si', titulo: 'Teléfono', dato: 'telefono' },
      { clave: 'whatsapp', tipo: 'si', titulo: 'WhatsApp', dato: 'whatsapp' },
      { titulo: 'Cuerpo' },
      { clave: 'modificadores', tipo: 'si', titulo: 'Desglose de opciones bajo cada platillo' },
      { clave: 'totalGrande', tipo: 'si', titulo: 'Total en letra grande' },
      { clave: 'pie', tipo: 'texto', titulo: 'Mensaje al pie', ayuda: 'Por ejemplo: «Gracias por su visita · @mapolato». Déjalo vacío para no imprimir mensaje.' },
    ],
  };
  const PAPELES = [[32, '58 mm'], [42, '80 mm'], [48, '80 mm a todo lo ancho']];

  let cont = null, estado = null, porDefecto = null, negocio = {};
  let doc = 'comanda', ancho = 42, tGuardar = null, tVista = null, turnoVista = 0, ultimoGuardado = null;

  function estilos() {
    if (document.getElementById('dp-estilos')) return;
    const s = document.createElement('style');
    s.id = 'dp-estilos';
    s.textContent = `
      .dp-cab b{font-size:1.1rem;font-weight:800}.dp-cab p{font-size:.8rem;color:#888;margin:4px 0 14px}
      .dp-tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
      .dp-tab{border:1px solid #e5e2da;background:#fff;border-radius:10px;padding:8px 14px;font:inherit;font-size:.86rem;font-weight:700;cursor:pointer;color:#555}
      .dp-tab.activo{border-color:var(--color-brand);background:var(--color-brand-light);color:var(--color-brand)}
      .dp-cuerpo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
      @media (max-width:900px){.dp-cuerpo{grid-template-columns:1fr}}
      .dp-caja{background:#fff;border:1px solid #e5e2da;border-radius:12px;padding:14px 16px}
      .dp-grupo{font-size:.78rem;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:.04em;margin:14px 0 6px}
      .dp-grupo:first-child{margin-top:0}.dp-ayuda{font-size:.76rem;color:#888;margin:2px 0 6px;line-height:1.35}
      .dp-op{padding:8px 0;border-top:1px solid #f1f0ed}.dp-op:first-of-type{border-top:none}
      .dp-op label.dp-t{display:block;font-size:.88rem;font-weight:600;color:#222;margin-bottom:6px}
      .dp-seg{display:flex;flex-wrap:wrap;gap:6px}
      .dp-seg button{border:1px solid #e5e2da;background:#fff;border-radius:8px;padding:6px 10px;font:inherit;font-size:.82rem;cursor:pointer;color:#444}
      .dp-seg button.activo{border-color:var(--color-brand);background:var(--color-brand);color:#fff;font-weight:700}
      .dp-si{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;font-size:.88rem;font-weight:600;color:#222}
      .dp-si input{width:20px;height:20px;accent-color:var(--color-brand);flex-shrink:0}
      .dp-si small{display:block;font-weight:400;color:#999;font-size:.74rem}
      .dp-texto{width:100%;box-sizing:border-box;border:1px solid #e5e2da;border-radius:8px;padding:8px 10px;font:inherit;font-size:.88rem}
      .dp-vista-cab{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px;font-size:.8rem;color:#666}
      .dp-hoja-cont{background:#e9e6df;border-radius:10px;padding:14px 8px;display:flex;justify-content:center;overflow:hidden}
      .dp-hoja{font-family:Consolas,'Courier New',monospace;background:#fdfdfb;box-shadow:0 1px 4px rgba(0,0,0,.25);padding:2ch 0 2.5ch}
      .dp-area{outline:1px dashed rgba(0,0,0,.08)}
      .dp-r{white-space:pre;height:2.5ch;line-height:2.5ch}
      .dp-r span{display:inline-block;color:#707070;font-weight:400;transform-origin:top left;line-height:2ch}
      .dp-r.b span{color:#111;font-weight:700}.dp-r.alto{height:4.2ch}.dp-r.alto span{transform:scaleY(2)}
      .dp-r.ancho span{font-size:2em;transform:none}.dp-r.inv span{background:#111;color:#fff}.dp-r.sub span{text-decoration:underline}
      .dp-r.centro{text-align:center}.dp-r.centro span{transform-origin:top center}.dp-r.der{text-align:right}.dp-r.der span{transform-origin:top right}
      .dp-qr{margin:.5ch auto;width:14ch;height:14ch;background:repeating-linear-gradient(45deg,#222 0 3px,#fff 3px 6px)}
      .dp-corte{border-top:1px dashed #bbb;margin-top:1ch;font-size:10px;color:#aaa;font-family:system-ui}
      .dp-pie{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-top:14px}
      .dp-estado{font-size:.84rem;font-weight:700}.dp-estado.ok{color:#15803d}.dp-estado.err{color:#b91c1c}.dp-estado.pend{color:#888}
      .dp-reset{border:1px solid #e5e2da;background:#fff;border-radius:8px;padding:8px 12px;font:inherit;font-size:.82rem;cursor:pointer;color:#555}
      .dp-nota{font-size:.78rem;color:#888;margin-top:10px;line-height:1.4}`;
    document.head.appendChild(s);
  }

  async function abrir(el) {
    cont = el;
    if (!cont) return;
    estilos();
    cont.innerHTML = '<div class="dp-nota">Cargando el diseño…</div>';
    try {
      const r = await pedir('/api/impresion/formato');
      if (!r.ok) throw new Error(r.status === 403 ? 'Solo el administrador puede cambiar el diseño.' : 'No se pudo cargar el diseño.');
      const d = await r.json();
      estado = d.formato; porDefecto = d.porDefecto; negocio = d.negocio || {};
      ancho = d.anchoSugerido || 42;
      pintar();
      vista();
    } catch (e) {
      cont.innerHTML = `<div class="dp-caja" style="color:#b91c1c">${esc(e.message)}</div>`;
    }
  }

  function pintar() {
    cont.innerHTML = `
      <div class="dp-cab"><b>🧾 Diseño de ticket y comanda</b>
        <p>Cómo se ve el papel de cocina y el ticket del cliente. Cada cambio se guarda solo y vale para todas las impresoras de esta sucursal.</p></div>
      <div class="dp-tabs" role="tablist">
        <button class="dp-tab ${doc === 'comanda' ? 'activo' : ''}" data-dp-doc="comanda" role="tab">🍳 Comanda de cocina</button>
        <button class="dp-tab ${doc === 'cuenta' ? 'activo' : ''}" data-dp-doc="cuenta" role="tab">🧾 Ticket del cliente</button>
      </div>
      <div class="dp-cuerpo">
        <div class="dp-caja" id="dp-controles"></div>
        <div class="dp-caja">
          <div class="dp-vista-cab"><span>Papel:</span>${PAPELES.map(([a, t]) =>
            `<span class="dp-seg"><button data-dp-ancho="${a}" class="${ancho === a ? 'activo' : ''}">${t}</button></span>`).join('')}</div>
          <div class="dp-hoja-cont" id="dp-hoja-cont"><div class="dp-nota">Preparando la vista previa…</div></div>
          <div class="dp-nota">Vista previa a escala con un pedido de ejemplo. Es exactamente lo que arma el sistema para la impresora;
            se verá en papel en las computadoras que ya tengan la versión nueva de Xabor Edge.</div>
        </div>
      </div>
      <div class="dp-pie"><span class="dp-estado pend" id="dp-estado">${ultimoGuardado ? 'Guardado ✓' : 'Sin cambios'}</span>
        <button class="dp-reset" id="dp-reset">Volver al diseño de fábrica</button></div>`;
    cont.querySelectorAll('[data-dp-doc]').forEach(b => b.onclick = () => { doc = b.dataset.dpDoc; pintar(); vista(); });
    cont.querySelectorAll('[data-dp-ancho]').forEach(b => b.onclick = () => { ancho = Number(b.dataset.dpAncho); pintar(); vista(); });
    cont.querySelector('#dp-reset').onclick = restaurar;
    pintarControles();
  }

  function pintarControles() {
    const caja = cont.querySelector('#dp-controles');
    if (!caja) return;
    const seccion = doc === 'cuenta' ? 'ticket' : 'comanda';
    const valores = estado[seccion];
    caja.innerHTML = OPCIONES[seccion].map((o, i) => {
      if (!o.clave) return `<div class="dp-grupo">${esc(o.titulo)}</div>${o.ayuda ? `<div class="dp-ayuda">${esc(o.ayuda)}</div>` : ''}`;
      const ayuda = o.ayuda ? `<div class="dp-ayuda">${esc(o.ayuda)}</div>` : '';
      if (o.tipo === 'opciones') {
        return `<div class="dp-op"><label class="dp-t">${esc(o.titulo)}</label><div class="dp-seg">${o.valores.map(([v, t]) =>
          `<button data-dp-op="${i}" data-dp-valor='${esc(JSON.stringify(v))}' class="${valores[o.clave] === v ? 'activo' : ''}">${esc(t)}</button>`).join('')}</div>${ayuda}</div>`;
      }
      if (o.tipo === 'si') {
        const falta = o.dato && !String(negocio[o.dato] || '').trim();
        return `<div class="dp-op"><label class="dp-si"><span>${esc(o.titulo)}${falta ? '<small>No está capturado en Configuración → Negocio</small>' : ''}</span>
          <input type="checkbox" data-dp-op="${i}" ${valores[o.clave] ? 'checked' : ''}></label>${ayuda}</div>`;
      }
      return `<div class="dp-op"><label class="dp-t" for="dp-op-${i}">${esc(o.titulo)}</label>
        <input class="dp-texto" id="dp-op-${i}" data-dp-op="${i}" maxlength="160" value="${esc(valores[o.clave])}">${ayuda}</div>`;
    }).join('');
    caja.querySelectorAll('button[data-dp-op]').forEach(b => b.onclick = () => cambiar(seccion, OPCIONES[seccion][Number(b.dataset.dpOp)].clave, JSON.parse(b.dataset.dpValor)));
    caja.querySelectorAll('input[type=checkbox][data-dp-op]').forEach(c => c.onchange = () => cambiar(seccion, OPCIONES[seccion][Number(c.dataset.dpOp)].clave, c.checked));
    caja.querySelectorAll('input.dp-texto').forEach(t => t.oninput = () => cambiar(seccion, OPCIONES[seccion][Number(t.dataset.dpOp)].clave, t.value, { sinRepintar: true }));
  }

  function cambiar(seccion, clave, valor, { sinRepintar = false } = {}) {
    estado[seccion][clave] = valor;
    if (!sinRepintar) pintarControles();
    marcar('pend', 'Guardando…');
    clearTimeout(tGuardar);
    tGuardar = setTimeout(guardar, 700);
    clearTimeout(tVista);
    tVista = setTimeout(vista, 250);
  }

  function marcar(clase, texto) {
    const e = cont && cont.querySelector('#dp-estado');
    if (e) { e.className = 'dp-estado ' + clase; e.textContent = texto; }
  }

  async function guardar() {
    try {
      const r = await pedir('/api/impresion/formato', { method: 'PUT', body: JSON.stringify({ formato: estado }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error || 'No se pudo guardar');
      estado = d.formato;              // lo que quedó guardado, ya validado
      ultimoGuardado = Date.now();
      marcar('ok', 'Guardado ✓');
    } catch (e) {
      marcar('err', 'No se pudo guardar. Revisa la conexión; se reintentará con tu siguiente cambio.');
    }
  }

  async function restaurar() {
    if (!confirm('¿Volver al diseño de fábrica? Se reemplazan las opciones de comanda y ticket de esta sucursal.')) return;
    estado = JSON.parse(JSON.stringify(porDefecto));
    pintarControles();
    marcar('pend', 'Guardando…');
    await guardar();
    vista();
  }

  async function vista() {
    const hojaCont = cont && cont.querySelector('#dp-hoja-cont');
    if (!hojaCont) return;
    const turno = ++turnoVista;
    try {
      const r = await pedir('/api/impresion/formato/vista-previa', { method: 'POST', body: JSON.stringify({ documento: doc, formato: estado, ancho }) });
      const d = await r.json();
      if (turno !== turnoVista) return;        // llegó una respuesta vieja
      if (!r.ok) throw new Error(d.error || 'sin vista previa');
      hojaCont.innerHTML = hoja(d.renglones, d.ancho);
      ajustarEscala(hojaCont, d.ancho);
    } catch (e) {
      if (turno === turnoVista) hojaCont.innerHTML = `<div class="dp-nota" style="color:#b91c1c">No se pudo armar la vista previa.</div>`;
    }
  }

  // Papel real: 58 mm (cabezal de 48 mm, 32 letras) u 80 mm (cabezal de 72 mm,
  // 48 letras). Una letra normal mide 1,5 mm y en CSS 1ch = 1 letra.
  function medidas(cols) {
    return cols <= 32 ? { papel: 58 / 1.5, cabezal: 32 } : { papel: 80 / 1.5, cabezal: 48 };
  }

  function hoja(renglones, cols) {
    const m = medidas(cols);
    const filas = (renglones || []).map(r => {
      if (typeof r.texto === 'string') {
        const cls = ['dp-r', r.negrita ? 'b' : '', (r.tam === 'alto' || r.tam === 'doble') ? 'alto' : '',
          (r.tam === 'ancho' || r.tam === 'doble') ? 'ancho' : '', r.invertido ? 'inv' : '', r.subrayado ? 'sub' : '',
          r.alinear === 'centro' ? 'centro' : (r.alinear === 'der' ? 'der' : '')].join(' ');
        const aire = r.aire ? ` style="letter-spacing:${(r.aire / 12).toFixed(3)}ch"` : '';
        return `<div class="${cls}"><span${aire}>${esc(r.texto) || '&nbsp;'}</span></div>`;
      }
      if (r.linea) return `<div class="dp-r"><span>${(r.linea === '-' ? '-' : '=').repeat(cols)}</span></div>`;
      if (r.espacio) return '<div class="dp-r"><span>&nbsp;</span></div>'.repeat(Math.max(1, Math.min(10, r.espacio)));
      if (r.qr) return '<div class="dp-qr" title="Código QR"></div>';
      if (r.corte) return '<div class="dp-corte">✂ corte</div>';
      return '';
    }).join('');
    return `<div class="dp-hoja" style="width:${m.papel.toFixed(2)}ch"><div class="dp-area" style="width:${m.cabezal}ch;margin-left:${((m.papel - m.cabezal) / 2).toFixed(2)}ch">${filas}</div></div>`;
  }

  function ajustarEscala(hojaCont, cols) {
    const h = hojaCont.querySelector('.dp-hoja');
    if (!h) return;
    const disponible = Math.max(200, hojaCont.clientWidth - 16);
    const papelCh = medidas(cols).papel;
    // Consolas: 1ch ≈ 0,55 em.
    h.style.fontSize = Math.max(6, Math.min(14, disponible / (papelCh * 0.56))).toFixed(2) + 'px';
  }

  window.XaborDisenoPapel = { abrir };
})();
