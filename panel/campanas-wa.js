// ─── Clientes → Campañas: campañas de WhatsApp con plantilla aprobada ────────
//
// Pedido de Mario (20-nov-2026, «sí, prepáralas»). La campaña de antes mandaba
// texto libre, que WhatsApp solo entrega a quien escribió en las últimas 24 h.
// Esta elige una plantilla aprobada por Meta, así le llega a cualquier cliente;
// Meta cobra cada mensaje a la cuenta de WhatsApp del negocio.
//
// Archivo aparte de index.html por la misma razón que descuento-cierre.js: el
// panel es un solo <script> donde una función con nombre repetido pisa en
// silencio a la otra. Todo vive en esta IIFE y lo único global es
// `XaborCampanasWa`. Botones por delegación de eventos, sin onclick en línea.
//
// Habla solo con /api/admin/campanas-wa (src/services/campanasWaRutas.js, solo
// administradores). Mandar solo deja la cola: la manda el servidor poco a poco.
(function () {
  const E = { cont: null, campanas: [], meta: null, analisis: null, revisado: null, ocupado: false, reloj: null };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function fecha(iso) {
    const f = iso ? new Date(iso) : null;
    if (!f || isNaN(f)) return '';
    return `${f.getDate()} ${MESES[f.getMonth()]} ${String(f.getHours()).padStart(2, '0')}:${String(f.getMinutes()).padStart(2, '0')}`;
  }
  const usd = n => `US$${Number(n || 0).toFixed(2)}`;
  // La tarifa por mensaje lleva milésimas (0.045, 0.0085): con dos decimales mentiría.
  const tarifa = n => `US$${Number(n || 0).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  const CALIDAD = { GREEN: 'Alta', YELLOW: 'Media', RED: 'Baja' };
  const LIMITE = { TIER_50: '50', TIER_250: '250', TIER_1K: '1,000', TIER_10K: '10,000', TIER_100K: '100,000', TIER_UNLIMITED: 'sin límite' };
  const CATEGORIA = { MARKETING: 'Marketing', UTILITY: 'Utilidad' };

  async function pedir(url, opciones) {
    const r = await apiFetch(url, opciones);
    const d = await r.json().catch(() => ({}));
    return { r, d };
  }
  const post = cuerpo => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

  function decir(t, color) {
    const el = $('cwa-estado');
    if (el) { el.style.color = color || 'var(--color-text-secondary)'; el.textContent = t || ''; }
  }

  // ── Historial ────────────────────────────────────────────────────────────
  function chipEstado(c) {
    if (c.estado === 'enviando') {
      const espera = c.reanudar && new Date(c.reanudar) > new Date();
      return `<span class="tnd-chip pausada">${espera ? 'Esperando (Meta pidió bajar la velocidad)' : 'Mandándose'}</span>`;
    }
    if (c.estado === 'detenida') return '<span class="tnd-chip borrador">Detenida</span>';
    return '<span class="tnd-chip publicada">Terminada</span>';
  }

  function filaCampana(c) {
    const cabeza = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap;">
        <div><div style="font-weight:800;font-size:0.88rem;">${esc(c.nombre)}</div>
          <div class="sub" style="margin:2px 0 0;">${esc(fecha(c.creada))}${c.plantilla ? ` · plantilla ${esc(c.plantilla)}` : ''}</div></div>
        ${chipEstado(c)}</div>`;
    if (c.tipo !== 'plantilla') {
      return `<div class="tnd-card" style="margin-bottom:10px;">${cabeza}
        <div class="sub" style="margin:8px 0 0;">Texto libre (versión anterior) · ${esc(c.total)} clientes · el sistema contó ${esc(c.enviados)} como enviados
          · respondieron ${esc(c.respondieron)}. Meta no da acuse de estas: solo llegaron a quien había escrito en las últimas 24 h.</div></div>`;
    }
    const cifras = [
      ['Clientes', c.total], ['En cola', c.enCola], ['Enviados', c.enviados], ['Entregados', c.entregados], ['Leídos', c.leidos],
      ['No llegaron', c.noLlegaron], ['Respondieron', c.respondieron],
    ].filter(([n, v]) => v || ['Clientes', 'Enviados', 'Entregados'].includes(n));
    if (c.inciertos) cifras.push(['Sin confirmar', c.inciertos]);
    if (c.cancelados) cifras.push(['Cancelados', c.cancelados]);
    const motivos = (c.motivos || []).map(m => `<li>${esc(m.n)} · ${esc(m.explicacion)}</li>`).join('');
    return `<div class="tnd-card" style="margin-bottom:10px;" data-campana="${esc(c.id)}">${cabeza}
      <div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;">
        ${cifras.map(([n, v]) => `<div style="min-width:74px;"><div style="font-size:1rem;font-weight:800;">${esc(v)}</div>
          <div style="font-size:0.7rem;color:var(--color-text-secondary);">${esc(n)}</div></div>`).join('')}
      </div>
      ${c.motivoDetenida ? `<div class="tnd-aviso alerta" style="margin-top:10px;">⚠️ <div>${esc(c.motivoDetenida)}</div></div>` : ''}
      ${motivos ? `<div class="sub" style="margin:10px 0 0;">Por qué no llegaron:<ul style="margin:4px 0 0 18px;padding:0;">${motivos}</ul></div>` : ''}
      ${c.estado === 'enviando' ? `<div style="margin-top:10px;"><button class="tnd-btn sec chico" data-acc="detener" data-id="${esc(c.id)}">Detener</button></div>` : ''}
    </div>`;
  }

  function pintarHistorial() {
    const el = $('cwa-historial');
    if (!el) return;
    el.innerHTML = E.campanas.length
      ? E.campanas.map(filaCampana).join('')
      : '<div class="tnd-vacio">Todavía no hay campañas.</div>';
    clearTimeout(E.reloj);
    // Mientras una se manda, el historial se refresca solo (y solo si se ve).
    if (E.campanas.some(c => c.tipo === 'plantilla' && c.estado === 'enviando')) {
      E.reloj = setTimeout(() => { if (E.cont && E.cont.offsetParent !== null) cargarHistorial(); }, 10000);
    }
  }

  async function cargarHistorial() {
    try {
      const { r, d } = await pedir('/api/admin/campanas-wa');
      if (r.status === 401 || r.status === 403) { E.cont.innerHTML = ''; return; }
      if (!r.ok) throw new Error(d.error || 'No se pudo leer el historial');
      E.campanas = d.campanas || [];
      pintarHistorial();
    } catch (e) {
      const el = $('cwa-historial');
      if (el) el.innerHTML = `<div class="tnd-aviso alerta">⚠️ <div>${esc(e.message)}</div></div>`;
    }
  }

  // ── Formulario ───────────────────────────────────────────────────────────
  function pintarConexion() {
    const m = E.meta;
    const el = $('cwa-conexion');
    if (!el || !m) return;
    const partes = [];
    if (m.numero?.calidad) partes.push(`Calidad del número: <strong>${esc(CALIDAD[m.numero.calidad] || m.numero.calidad)}</strong>`);
    if (m.numero?.limite) partes.push(`Puede escribirle a <strong>${esc(LIMITE[m.numero.limite] || m.numero.limite)}</strong> personas nuevas al día`);
    el.innerHTML = `${partes.length ? `<div class="sub" style="margin:0 0 8px;">${partes.join(' · ')}</div>` : ''}
      ${m.trazabilidad ? '' : `<div class="tnd-aviso alerta" style="margin-bottom:10px;">⚠️ <div>El seguimiento de entregas de WhatsApp está
        apagado en este negocio: la campaña sale, pero no podremos decirte a quién le llegó ni quién la leyó.</div></div>`}`;
  }

  function pintarPlantillas() {
    const m = E.meta;
    const sel = $('cwa-plantilla'); const otras = $('cwa-otras'); const ayuda = $('cwa-sin-plantillas');
    const buenas = (m?.plantillas || []).filter(p => p.compatible);
    const malas = (m?.plantillas || []).filter(p => !p.compatible);
    sel.innerHTML = buenas.length
      ? '<option value="">Elige una plantilla…</option>' + buenas.map((p, i) =>
        `<option value="${i}">${esc(p.nombre)} · ${esc(p.idioma)} · ${esc(CATEGORIA[p.categoria] || p.categoria)}</option>`).join('')
      : '<option value="">No hay plantillas listas</option>';
    sel.disabled = !buenas.length;
    sel.dataset.lista = JSON.stringify(buenas.map(p => [p.nombre, p.idioma]));
    ayuda.style.display = buenas.length ? 'none' : '';
    otras.innerHTML = malas.length ? `<details style="margin-top:6px;"><summary class="sub" style="cursor:pointer;margin:0;">
        ${malas.length} plantilla${malas.length === 1 ? '' : 's'} que todavía no se pueden mandar</summary>
        <ul class="sub" style="margin:6px 0 0 18px;padding:0;">${malas.map(p =>
          `<li><strong>${esc(p.nombre)}</strong> (${esc(p.idioma)}): ${esc(p.razones.join('; '))}</li>`).join('')}</ul></details>` : '';
    E.analisis = null;
    pintarVariables();
  }

  function plantillaElegida() {
    const sel = $('cwa-plantilla');
    if (!sel.value) return null;
    const buenas = (E.meta?.plantillas || []).filter(p => p.compatible);
    return buenas[Number(sel.value)] || null;
  }

  function etiqueta(r) {
    if (r.tipo === 'imagen') return 'Imagen del encabezado (liga pública https://…)';
    if (r.lugar === 'boton') return r.tipo === 'cupon' ? 'Código del botón «copiar código»' : 'Final de la liga del botón';
    return `${r.lugar === 'encabezado' ? 'Encabezado' : 'Mensaje'}: {{${r.param}}}${r.ejemplo ? ` (ejemplo: ${r.ejemplo})` : ''}`;
  }

  function pintarVariables() {
    const p = plantillaElegida();
    E.analisis = p;
    const cont = $('cwa-variables');
    const muestra = $('cwa-muestra');
    if (!p) { cont.innerHTML = ''; muestra.innerHTML = ''; return; }
    muestra.innerHTML = `<div class="sub" style="margin:0 0 4px;">Así está escrita en Meta:</div>
      <div style="background:var(--color-surface-2);border-radius:10px;padding:10px 12px;font-size:0.82rem;white-space:pre-wrap;">${
        p.encabezado?.tipo === 'texto' ? `<strong>${esc(p.encabezado.texto)}</strong>\n` : p.encabezado?.tipo === 'imagen' ? '🖼️ [imagen]\n' : ''}${
        esc(p.cuerpo)}${p.pie ? `\n<span style="color:var(--color-text-muted);">${esc(p.pie)}</span>` : ''}${
        p.botones.length ? `\n${p.botones.map(b => `[ ${esc(b.texto)} ]`).join(' ')}` : ''}</div>`;
    cont.innerHTML = p.ranuras.map(r => {
      const puedeNombre = r.tipo === 'texto';
      return `<div class="tnd-campo" data-ranura="${esc(r.clave)}">
        <label>${esc(etiqueta(r))}</label>
        ${puedeNombre ? `<select data-fuente style="margin-bottom:6px;">
            <option value="nombre">El nombre del cliente</option><option value="fijo">Un texto que yo escribo</option></select>` : ''}
        <input type="text" data-texto placeholder="${esc(r.ejemplo || '')}" style="${puedeNombre ? 'display:none;' : ''}">
      </div>`;
    }).join('') + (p.ranuras.some(r => r.tipo === 'texto') ? `<div class="tnd-campo" id="cwa-respaldo-campo">
        <label>Si no sabemos el nombre del cliente, poner:</label>
        <input type="text" id="cwa-respaldo" value="cliente" maxlength="30"></div>` : '');
    ajustarRespaldo();
  }

  function ajustarRespaldo() {
    const campo = $('cwa-respaldo-campo');
    if (!campo) return;
    const usa = [...$('cwa-variables').querySelectorAll('[data-fuente]')].some(s => s.value === 'nombre');
    campo.style.display = usa ? '' : 'none';
  }

  function datosFormulario() {
    const p = E.analisis;
    const variables = {};
    if (p) {
      for (const r of p.ranuras) {
        const caja = $('cwa-variables').querySelector(`[data-ranura="${CSS.escape(r.clave)}"]`);
        const fuente = caja?.querySelector('[data-fuente]')?.value || 'fijo';
        variables[r.clave] = fuente === 'nombre' ? { fuente } : { fuente: 'fijo', texto: caja?.querySelector('[data-texto]')?.value || '' };
      }
    }
    return {
      nombre: $('cwa-nombre').value.trim(), plantilla: p?.nombre, idioma: p?.idioma, variables,
      respaldoNombre: $('cwa-respaldo')?.value || '', segmento: $('cwa-segmento').value,
      excluirRecientes: $('cwa-excluir').checked,
    };
  }

  // Cualquier cambio invalida lo revisado: no se manda algo distinto a lo que se vio.
  function invalidar() {
    E.revisado = null;
    $('cwa-resumen').innerHTML = '';
    $('cwa-mandar').disabled = true;
    $('cwa-mandar').textContent = 'Mandar campaña';
  }

  function pintarResumen(d) {
    const ex = d.excluidos || {};
    const fuera = [
      ex.recientes ? `${ex.recientes} ya recibieron una campaña en los últimos ${E.meta?.diasSinRepetir || 7} días` : '',
      ex.pidieronBaja ? `${ex.pidieronBaja} pidieron no recibir promociones` : '',
      ex.sinNumero ? `${ex.sinNumero} sin número válido` : '',
      ex.repetidos ? `${ex.repetidos} repetidos` : '',
    ].filter(Boolean);
    const v = d.vista || {};
    const h = E.meta?.horario || { desde: 9, hasta: 21 };
    $('cwa-resumen').innerHTML = `
      <div class="sub" style="margin:4px 0 4px;">Así le llegará al primer cliente de la lista:</div>
      <div style="background:#e7f8dd;color:#111;border-radius:10px;padding:10px 12px;font-size:0.84rem;white-space:pre-wrap;max-width:420px;">${
        v.imagen ? `<img src="${esc(v.imagen)}" alt="" style="max-width:100%;border-radius:8px;display:block;margin-bottom:6px;">` : ''}${
        v.encabezado ? `<strong>${esc(v.encabezado)}</strong>\n` : ''}${esc(v.cuerpo)}${
        v.pie ? `\n<span style="color:#667;">${esc(v.pie)}</span>` : ''}${
        (v.botones || []).length ? `\n${v.botones.map(b => `[ ${esc(b)} ]`).join(' ')}` : ''}</div>
      <div style="margin-top:10px;font-size:0.9rem;"><strong>Le llegaría a ${esc(d.total)} cliente${d.total === 1 ? '' : 's'}.</strong></div>
      ${fuera.length ? `<div class="sub" style="margin:2px 0 0;">No se incluyen: ${esc(fuera.join(' · '))}.</div>` : ''}
      <div class="sub" style="margin:6px 0 0;">Costo aproximado: <strong>${esc(usd(d.costo?.totalUsd))}</strong>
        (${esc(CATEGORIA[d.categoria] || d.categoria)}, ~${esc(tarifa(d.costo?.tarifaUsd))} por mensaje). Meta lo cobra a la cuenta
        de WhatsApp del negocio con su tarifa del día.</div>
      <div class="sub" style="margin:4px 0 0;">Se manda poco a poco, de ${esc(h.desde)}:00 a ${esc(h.hasta)}:00. Si ya es más tarde,
        empieza mañana a las ${esc(h.desde)}:00.</div>`;
  }

  async function revisar() {
    const datos = datosFormulario();
    if (!datos.plantilla) return decir('Elige una plantilla.', 'var(--color-danger)');
    decir('Revisando…');
    const { r, d } = await pedir('/api/admin/campanas-wa/vista-previa', post(datos));
    if (!r.ok) return decir(d.error || 'No se pudo revisar', 'var(--color-danger)');
    E.revisado = { datos, total: d.total, costo: d.costo };
    pintarResumen(d);
    const b = $('cwa-mandar');
    b.disabled = !d.total;
    b.textContent = d.total ? `Mandar a ${d.total} cliente${d.total === 1 ? '' : 's'}` : 'Nadie la recibiría';
    decir('');
  }

  async function mandar() {
    const rv = E.revisado;
    if (!rv) return;
    if (!rv.datos.nombre) return decir('Ponle un nombre a la campaña.', 'var(--color-danger)');
    if (!confirm(`¿Mandar «${rv.datos.nombre}» a ${rv.total} clientes?\n\nCosto aproximado: ${usd(rv.costo?.totalUsd)} que Meta cobra a tu cuenta de WhatsApp. Ya no se puede deshacer lo que salga (sí puedes detener lo que falte).`)) return;
    decir('Guardando…');
    const { r, d } = await pedir('/api/admin/campanas-wa', post({ ...rv.datos, totalVisto: rv.total }));
    if (!r.ok) {
      if (d.codigo === 'LISTA_CAMBIO') invalidar();
      return decir(d.error || 'No se pudo mandar', 'var(--color-danger)');
    }
    cerrar();
    await cargarHistorial();
  }

  async function prueba() {
    const datos = datosFormulario();
    if (!datos.plantilla) return decir('Elige una plantilla.', 'var(--color-danger)');
    const telefono = $('cwa-prueba-tel').value.trim();
    decir('Mandando la prueba…');
    // Sin nombre de cliente: la prueba muestra lo que ven los que no tienen nombre.
    const { r, d } = await pedir('/api/admin/campanas-wa/prueba', post({ ...datos, telefono }));
    if (!r.ok) return decir(d.error || 'No se pudo mandar la prueba', 'var(--color-danger)');
    decir('✓ Prueba mandada. Revisa tu WhatsApp.', 'var(--color-success)');
  }

  async function detener(id) {
    if (!confirm('¿Detener la campaña? Lo que ya salió no se puede regresar; a los que faltan ya no se les manda.')) return;
    const { r, d } = await pedir(`/api/admin/campanas-wa/${encodeURIComponent(id)}/detener`, post({}));
    if (!r.ok) alert(d.error || 'No se pudo detener');
    await cargarHistorial();
  }

  async function cargarPlantillas(recargar) {
    const sel = $('cwa-plantilla');
    sel.innerHTML = '<option value="">Leyendo tus plantillas de Meta…</option>';
    sel.disabled = true;
    const { r, d } = await pedir(`/api/admin/campanas-wa/plantillas${recargar ? '?recargar=1' : ''}`);
    if (!r.ok || !d.conectado || d.motivo) {
      E.meta = { plantillas: [] };
      sel.innerHTML = '<option value="">Sin plantillas</option>';
      $('cwa-conexion').innerHTML = `<div class="tnd-aviso alerta" style="margin-bottom:10px;">⚠️ <div>${esc(d.motivo || d.error || 'No se pudieron leer las plantillas')}</div></div>`;
      $('cwa-sin-plantillas').style.display = '';
      return;
    }
    E.meta = d;
    $('cwa-segmento').innerHTML = (d.segmentos || []).map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    $('cwa-dias').textContent = String(d.diasSinRepetir || 7);
    pintarConexion();
    pintarPlantillas();
  }

  function abrirModal() {
    $('cwa-modal').style.display = 'flex';
    $('cwa-nombre').value = '';
    invalidar();
    decir('');
    cargarPlantillas(false);
  }
  function cerrar() { $('cwa-modal').style.display = 'none'; }

  function esqueleto() {
    // .sub del panel solo tiene estilo dentro de .tnd-card; aquí también vale en el formulario.
    E.cont.innerHTML = `<style>.cwa-raiz .sub { font-size:0.78rem; color:var(--color-text-secondary); }</style>
      <div class="cwa-raiz">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div style="font-size:1.1rem;font-weight:800;">Campañas de WhatsApp</div>
        <button class="tnd-btn" data-acc="nueva">📣 Nueva campaña</button>
      </div>
      <div class="sub" style="font-size:0.8rem;color:var(--color-text-secondary);margin:6px 0 16px;max-width:640px;">
        Se mandan con una plantilla aprobada por Meta, así le llegan a cualquier cliente y no solo a quien te escribió hoy.
        Meta cobra cada mensaje a la cuenta de WhatsApp del negocio.</div>
      <div style="font-weight:700;font-size:0.85rem;margin-bottom:10px;color:var(--color-text-secondary);">Historial de campañas</div>
      <div id="cwa-historial"><div class="tnd-vacio">Cargando…</div></div>

      <div id="cwa-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;align-items:center;justify-content:center;">
        <div style="background:var(--color-surface);border-radius:16px;padding:22px;max-width:540px;width:92%;max-height:90vh;overflow-y:auto;position:relative;box-sizing:border-box;">
          <button data-acc="cerrar" aria-label="Cerrar" style="position:absolute;top:12px;right:12px;border:none;background:none;font-size:1.3rem;cursor:pointer;color:var(--color-text-muted);">✕</button>
          <div style="font-size:1.05rem;font-weight:800;margin-bottom:14px;">📣 Nueva campaña</div>
          <div id="cwa-conexion"></div>
          <div class="tnd-campo"><label for="cwa-nombre">Nombre de la campaña (solo lo ves tú)</label>
            <input id="cwa-nombre" type="text" maxlength="120" placeholder="Ej: 2x1 del jueves"></div>
          <div class="tnd-campo"><label for="cwa-plantilla">Plantilla aprobada por Meta</label>
            <select id="cwa-plantilla"></select>
            <div class="ayuda"><a href="#" data-acc="recargar">Recargar la lista</a></div>
            <div id="cwa-otras"></div></div>
          <div id="cwa-sin-plantillas" class="tnd-aviso info" style="display:none;margin-bottom:12px;">💡 <div>
            Para mandar una campaña primero crea la plantilla en WhatsApp Manager → <strong>Plantillas de mensajes</strong> →
            «Crear plantilla», categoría <strong>Marketing</strong> e idioma <strong>Español (MEX)</strong>. Meta la revisa
            (casi siempre en minutos, a veces hasta 24 h). Cuando diga «Activa», vuelve aquí y pulsa «Recargar la lista».
            <div style="margin-top:6px;"><a href="https://business.facebook.com/wa/manage/message-templates/" target="_blank" rel="noopener">Abrir WhatsApp Manager</a></div></div></div>
          <div id="cwa-muestra" style="margin-bottom:12px;"></div>
          <div id="cwa-variables"></div>
          <div class="tnd-campo"><label for="cwa-segmento">¿A quién?</label><select id="cwa-segmento"></select></div>
          <label style="display:flex;gap:8px;align-items:flex-start;font-size:0.8rem;margin-bottom:14px;cursor:pointer;">
            <input type="checkbox" id="cwa-excluir" checked style="margin-top:2px;">
            <span>No mandarle a quien ya recibió una campaña en los últimos <span id="cwa-dias">7</span> días</span></label>
          <button class="tnd-btn sec" data-acc="revisar" style="width:100%;">Revisar a quién le llega y cuánto cuesta</button>
          <div id="cwa-resumen" style="margin-top:12px;"></div>
          <div class="tnd-campo" style="margin-top:14px;"><label for="cwa-prueba-tel">Mándame una prueba a mi WhatsApp (10 dígitos)</label>
            <div style="display:flex;gap:8px;"><input id="cwa-prueba-tel" type="tel" inputmode="numeric" maxlength="13" placeholder="8781234567" style="flex:1;">
              <button class="tnd-btn sec chico" data-acc="prueba">Mandar prueba</button></div></div>
          <button class="tnd-btn" id="cwa-mandar" data-acc="mandar" disabled style="width:100%;padding:12px;">Mandar campaña</button>
          <div id="cwa-estado" style="margin-top:10px;font-size:0.82rem;font-weight:700;text-align:center;"></div>
        </div>
      </div>
      </div>`;
  }

  async function alClic(e) {
    const b = e.target.closest('[data-acc]');
    if (!b || b.disabled) return;
    const acc = b.dataset.acc;
    if (acc === 'recargar') e.preventDefault();
    if (acc === 'nueva') return abrirModal();
    if (acc === 'cerrar') return cerrar();
    if (E.ocupado) return;
    E.ocupado = true;
    try {
      if (acc === 'recargar') { invalidar(); await cargarPlantillas(true); }
      if (acc === 'revisar') await revisar();
      if (acc === 'mandar') await mandar();
      if (acc === 'prueba') await prueba();
      if (acc === 'detener') await detener(b.dataset.id);
    } catch (err) {
      decir(err.message || 'Algo falló', 'var(--color-danger)');
    } finally {
      E.ocupado = false;
    }
  }

  function alCambiar(e) {
    if (!e.target.closest('#cwa-modal') || e.target.id === 'cwa-prueba-tel' || e.target.id === 'cwa-nombre') return;
    if (e.target.id === 'cwa-plantilla') pintarVariables();
    if (e.target.matches('[data-fuente]')) {
      const caja = e.target.closest('[data-ranura]');
      caja.querySelector('[data-texto]').style.display = e.target.value === 'fijo' ? '' : 'none';
      ajustarRespaldo();
    }
    invalidar();
  }

  async function abrir(cont) {
    if (!cont) return;
    if (E.cont !== cont) {
      E.cont = cont;
      esqueleto();
      cont.addEventListener('click', alClic);
      cont.addEventListener('change', alCambiar);
      cont.addEventListener('input', alCambiar);
    }
    await cargarHistorial();
  }

  window.XaborCampanasWa = { abrir };
})();
