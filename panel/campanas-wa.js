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
    if (c.estado === 'programada') return '<span class="tnd-chip borrador">Programada</span>';
    if (c.estado === 'enviando' && c.pausada) return '<span class="tnd-chip borrador">Pausada</span>';
    if (c.estado === 'enviando') {
      const espera = c.reanudar && new Date(c.reanudar) > new Date();
      return `<span class="tnd-chip pausada">${espera ? 'Esperando (Meta pidió bajar la velocidad)'
        : c.tandaLlena ? 'Tanda completa: sigue en 24 h' : 'Mandándose'}</span>`;
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
    if (c.bajas) cifras.push(['Se dieron de baja', c.bajas]);
    const motivos = (c.motivos || []).map(m => `<li>${esc(m.n)} · ${esc(m.explicacion)}</li>`).join('');
    const tanda = c.tope24h ? `<div class="sub" style="margin:8px 0 0;">Tandas de hasta ${esc(c.tope24h)} mensajes cada 24 h
      (${esc(c.intentos24h || 0)} en las últimas 24 h)${c.umbralRechazoPct ? ` · se pausa sola si fallan más del ${esc(c.umbralRechazoPct)}% de los envíos` : ''}.</div>` : '';
    const programada = c.estado === 'programada' ? `<div class="tnd-aviso info" style="margin-top:10px;">🗓️ <div>
        Programada para el <strong>${esc(c.programadaTexto || fecha(c.programadaPara))}</strong> (hora del negocio). Justo antes de
        mandar a cada cliente se revisa otra vez que no se haya dado de baja.</div></div>
      <div style="margin-top:10px;"><button class="tnd-btn sec chico" data-acc="cancelar-programada" data-id="${esc(c.id)}">Cancelar programación</button></div>` : '';
    const acciones = c.estado !== 'enviando' ? '' : `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
        ${c.pausada ? `<button class="tnd-btn chico" data-acc="reanudar" data-id="${esc(c.id)}">Reanudar</button>`
          : `<button class="tnd-btn sec chico" data-acc="pausar" data-id="${esc(c.id)}">Pausar</button>`}
        <button class="tnd-btn sec chico" data-acc="detener" data-id="${esc(c.id)}">Detener</button></div>`;
    return `<div class="tnd-card" style="margin-bottom:10px;" data-campana="${esc(c.id)}">${cabeza}
      <div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;">
        ${cifras.map(([n, v]) => `<div style="min-width:74px;"><div style="font-size:1rem;font-weight:800;">${esc(v)}</div>
          <div style="font-size:0.7rem;color:var(--color-text-secondary);">${esc(n)}</div></div>`).join('')}
      </div>
      ${tanda}
      ${c.motivoDetenida ? `<div class="tnd-aviso alerta" style="margin-top:10px;">⚠️ <div>${esc(c.motivoDetenida)}</div></div>` : ''}
      ${c.pausada && c.motivoPausa ? `<div class="tnd-aviso alerta" style="margin-top:10px;">⏸️ <div>${esc(c.motivoPausa)}</div></div>` : ''}
      ${motivos ? `<div class="sub" style="margin:10px 0 0;">Por qué no llegaron:<ul style="margin:4px 0 0 18px;padding:0;">${motivos}</ul></div>` : ''}
      ${programada}
      ${acciones}
    </div>`;
  }

  function pintarHistorial() {
    const el = $('cwa-historial');
    if (!el) return;
    el.innerHTML = E.campanas.length
      ? E.campanas.map(filaCampana).join('')
      : '<div class="tnd-vacio">Todavía no hay campañas.</div>';
    clearTimeout(E.reloj);
    // Mientras una se manda, el historial se refresca solo (y solo si se ve);
    // con una programada, más despacio, para ver cuando arranca.
    const deCola = E.campanas.filter(c => c.tipo === 'plantilla');
    const cada = deCola.some(c => c.estado === 'enviando') ? 10000 : deCola.some(c => c.estado === 'programada') ? 60000 : 0;
    if (cada) {
      E.reloj = setTimeout(() => { if (E.cont && E.cont.offsetParent !== null) cargarHistorial(); }, cada);
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
    // Solo el hueco del nombre (lo decide el servidor: el que se llama
    // «nombre» o el {{1}} del cuerpo) empieza como «El nombre del cliente».
    // Los demás empiezan como texto fijo con su caja a la vista: antes todos
    // empezaban con el nombre y la promoción salía con el nombre del cliente.
    cont.innerHTML = p.ranuras.map(r => {
      const puedeNombre = r.tipo === 'texto';
      const esNombre = puedeNombre && r.esNombre === true;
      return `<div class="tnd-campo" data-ranura="${esc(r.clave)}">
        <label>${esc(etiqueta(r))}</label>
        ${puedeNombre ? `<select data-fuente style="margin-bottom:6px;">
            <option value="fijo"${esNombre ? '' : ' selected'}>Texto fijo</option>
            <option value="nombre"${esNombre ? ' selected' : ''}>El nombre del cliente</option></select>` : ''}
        ${esNombre ? '<div class="ayuda" data-aviso-nombre>Aquí parece ir el nombre del cliente. Si no, elige «Texto fijo».</div>' : ''}
        <input type="text" data-texto placeholder="${esc(r.ejemplo || '')}" style="${esNombre ? 'display:none;' : ''}">
        <div class="ayuda" data-error style="display:none;color:var(--color-danger);font-weight:700;"></div>
      </div>`;
    }).join('') + (p.ranuras.some(r => r.tipo === 'texto') ? `<div class="tnd-campo" id="cwa-respaldo-campo">
        <label>Si no sabemos el nombre del cliente, poner:</label>
        <input type="text" id="cwa-respaldo" value="${esc(E.meta?.respaldoNombre || 'buen día')}" maxlength="30"></div>` : '');
    ajustarRespaldo();
  }

  // Lo que se escribe a mano: no vacío y en un solo renglón (WhatsApp no
  // acepta saltos de línea en una variable). El aviso sale junto al campo; el
  // servidor revisa lo mismo.
  function revisarCampos() {
    const p = E.analisis;
    if (!p) return true;
    let primero = null;
    for (const r of p.ranuras) {
      const caja = $('cwa-variables').querySelector(`[data-ranura="${CSS.escape(r.clave)}"]`);
      if (!caja) continue;
      const fuente = caja.querySelector('[data-fuente]')?.value || 'fijo';
      const aviso = caja.querySelector('[data-error]');
      const valor = caja.querySelector('[data-texto]')?.value || '';
      const error = fuente !== 'fijo' ? '' : !valor.trim() ? 'Escribe este texto: no puede ir vacío.'
        : /[\r\n\t]/.test(valor) ? 'Sin saltos de línea: WhatsApp no los acepta en una variable. Escríbelo en un solo renglón.' : '';
      if (aviso) { aviso.textContent = error; aviso.style.display = error ? '' : 'none'; }
      if (error && !primero) primero = caja.querySelector('[data-texto]');
    }
    if (primero) { primero.focus(); decir('Revisa los campos marcados en rojo.', 'var(--color-danger)'); }
    return !primero;
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
      tope24h: Number($('cwa-tope').value) || null, umbralRechazoPct: Number($('cwa-umbral').value) || null,
    };
  }

  // ── Programar (bandera por negocio: sin ella no aparece) ──────────────────
  const programando = () => !!(E.meta?.programar && document.querySelector('#cwa-modal input[name="cwa-modo"]:checked')?.value === 'programar');
  // «2026-11-25T10:00» → «25 nov, 10:00» (es la hora del negocio, tal cual se eligió).
  function textoCuando(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v || '');
    return m ? `${Number(m[3])} ${MESES[Number(m[2]) - 1]}, ${Number(m[4])}:${m[5]}` : '';
  }
  // Sumar días a la fecha local que mandó el servidor, sin pasar por el reloj del equipo.
  function masDias(local, dias) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local || '');
    if (!m) return '';
    const f = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dias, Number(m[4]), Number(m[5])));
    return f.toISOString().slice(0, 16);
  }
  function pintarProgramar() {
    const caja = $('cwa-programar');
    if (!caja) return;
    const pr = E.meta?.programar;
    if (!pr) { caja.innerHTML = ''; return; }
    const h = E.meta?.horario || { desde: 9, hasta: 21 };
    caja.innerHTML = `<div class="tnd-campo"><label>¿Cuándo?</label>
        <label style="display:flex;gap:8px;align-items:center;font-size:0.85rem;cursor:pointer;margin:4px 0;">
          <input type="radio" name="cwa-modo" value="ahora" checked> Mandar ahora</label>
        <label style="display:flex;gap:8px;align-items:center;font-size:0.85rem;cursor:pointer;margin:4px 0;">
          <input type="radio" name="cwa-modo" value="programar"> Programar fecha y hora</label>
        <div id="cwa-cuando-campo" style="display:none;margin-top:6px;">
          <input id="cwa-cuando" type="datetime-local" step="60" min="${esc(masDias(pr.ahoraLocal, 0))}" max="${esc(masDias(pr.ahoraLocal, pr.maximoDias || 30))}">
          <div class="ayuda">Hora del negocio. Sale de ${esc(h.desde)}:00 a ${esc(h.hasta - 1)}:59, con al menos ${esc(pr.minimoMin || 10)} minutos
            de anticipación. La lista de clientes se queda como la revisaste; al mandar solo se quita a quien se dio de baja.</div>
          <div class="ayuda" id="cwa-cuando-error" style="display:none;color:var(--color-danger);font-weight:700;"></div>
        </div></div>`;
  }
  function revisarCuando() {
    if (!programando()) return true;
    const v = $('cwa-cuando').value;
    const h = E.meta?.horario || { desde: 9, hasta: 21 };
    const hora = Number((v.split('T')[1] || '').split(':')[0]);
    const error = !v ? 'Elige la fecha y la hora.'
      : (hora < h.desde || hora >= h.hasta) ? `Elige una hora entre ${h.desde}:00 y ${h.hasta - 1}:59.` : '';
    const aviso = $('cwa-cuando-error');
    aviso.textContent = error; aviso.style.display = error ? '' : 'none';
    if (error) decir(error, 'var(--color-danger)');
    return !error;
  }
  function textoBoton() {
    const b = $('cwa-mandar');
    const rv = E.revisado;
    if (!rv) { b.textContent = programando() ? 'Programar campaña' : 'Mandar campaña'; return; }
    const quienes = `${rv.total} cliente${rv.total === 1 ? '' : 's'}`;
    b.textContent = !rv.total ? 'Nadie la recibiría' : programando() ? `Programar para ${quienes}` : `Mandar a ${quienes}`;
  }

  // Cualquier cambio invalida lo revisado: no se manda algo distinto a lo que se vio.
  // (Cambiar CUÁNDO no cambia lo que se vio: no invalida.)
  function invalidar() {
    E.revisado = null;
    $('cwa-resumen').innerHTML = '';
    $('cwa-mandar').disabled = true;
    textoBoton();
  }

  const burbuja = v => `<div style="background:#e7f8dd;color:#111;border-radius:10px;padding:10px 12px;font-size:0.84rem;white-space:pre-wrap;max-width:420px;">${
        v.imagen ? `<img src="${esc(v.imagen)}" alt="" style="max-width:100%;border-radius:8px;display:block;margin-bottom:6px;">` : ''}${
        v.encabezado ? `<strong>${esc(v.encabezado)}</strong>\n` : ''}${esc(v.cuerpo)}${
        v.pie ? `\n<span style="color:#667;">${esc(v.pie)}</span>` : ''}${
        (v.botones || []).length ? `\n${v.botones.map(b => `[ ${esc(b)} ]`).join(' ')}` : ''}</div>`;

  function pintarResumen(d) {
    const ex = d.excluidos || {};
    const fuera = [
      ex.pidieronBaja ? `${ex.pidieronBaja} se dieron de baja` : '',
      ex.delNegocio ? `${ex.delNegocio} teléfono${ex.delNegocio === 1 ? '' : 's'} del negocio` : '',
      ex.internos ? `${ex.internos} interno${ex.internos === 1 ? '' : 's'}` : '',
      ex.repartidores ? `${ex.repartidores} repartidor${ex.repartidores === 1 ? '' : 'es'}` : '',
      ex.recientes ? `${ex.recientes} ya recibieron una campaña en los últimos ${E.meta?.diasSinRepetir || 7} días` : '',
      ex.sinNumero ? `${ex.sinNumero} sin número válido` : '',
      ex.repetidos ? `${ex.repetidos} repetidos` : '',
    ].filter(Boolean);
    const v = d.vista || {};
    const h = E.meta?.horario || { desde: 9, hasta: 21 };
    const t = d.tandas || {};
    $('cwa-resumen').innerHTML = `
      <div class="sub" style="margin:4px 0 4px;">Así le llegará a un cliente de la lista:</div>
      ${burbuja(v)}
      ${d.usaNombre && d.sinNombre ? `<div class="sub" style="margin:10px 0 4px;"><strong>${esc(d.sinNombre)}</strong> van sin nombre
        (no lo tenemos, o es algo como «Rappi 3259» o «Llevar»). A ellos les llega así:</div>${burbuja(d.vistaSinNombre || {})}` : ''}
      <div style="margin-top:10px;font-size:0.9rem;"><strong>Le llegaría a ${esc(d.total)} cliente${d.total === 1 ? '' : 's'}.</strong></div>
      ${fuera.length ? `<div class="sub" style="margin:2px 0 0;">No se incluyen: ${esc(fuera.join(' · '))}.</div>` : ''}
      ${t.tope24h ? `<div class="sub" style="margin:6px 0 0;">Sale en ${esc(t.cuantas)} tanda${t.cuantas === 1 ? '' : 's'} de hasta
        ${esc(t.tope24h)} mensajes cada 24 h, y se pausa sola si fallan más del ${esc(t.umbralRechazoPct)}% de los envíos.</div>` : ''}
      <div class="sub" style="margin:6px 0 0;">Costo aproximado: <strong>${esc(usd(d.costo?.totalUsd))}</strong>
        (${esc(CATEGORIA[d.categoria] || d.categoria)}, ~${esc(tarifa(d.costo?.tarifaUsd))} por mensaje). Meta lo cobra a la cuenta
        de WhatsApp del negocio con su tarifa del día.</div>
      <div class="sub" style="margin:4px 0 0;">Se manda poco a poco, de ${esc(h.desde)}:00 a ${esc(h.hasta)}:00. Si ya es más tarde,
        empieza mañana a las ${esc(h.desde)}:00.</div>`;
  }

  async function revisar() {
    const datos = datosFormulario();
    if (!datos.plantilla) return decir('Elige una plantilla.', 'var(--color-danger)');
    if (!revisarCampos()) return;
    decir('Revisando…');
    const { r, d } = await pedir('/api/admin/campanas-wa/vista-previa', post(datos));
    if (!r.ok) return decir(d.error || 'No se pudo revisar', 'var(--color-danger)');
    E.revisado = { datos, total: d.total, costo: d.costo };
    pintarResumen(d);
    $('cwa-mandar').disabled = !d.total;
    textoBoton();
    decir('');
  }

  async function mandar() {
    const rv = E.revisado;
    if (!rv) return;
    if (!rv.datos.nombre) return decir('Ponle un nombre a la campaña.', 'var(--color-danger)');
    if (!revisarCuando()) return;
    const programadaPara = programando() ? $('cwa-cuando').value : '';
    const costo = `Costo aproximado: ${usd(rv.costo?.totalUsd)} que Meta cobra a tu cuenta de WhatsApp. Sale en tandas de hasta ${rv.datos.tope24h || 250} cada 24 h.`;
    const pregunta = programadaPara
      ? `¿Programar «${rv.datos.nombre}» para el ${textoCuando(programadaPara)} (hora del negocio) a ${rv.total} clientes?\n\n${costo} Si a esa hora se está mandando otra campaña, esta espera a que termine (si se le pasan más de ${E.meta?.programar?.toleranciaHoras || 6} h, se cancela sola). Antes de que salga la puedes cancelar desde el historial.`
      : `¿Mandar «${rv.datos.nombre}» a ${rv.total} clientes?\n\n${costo} Ya no se puede deshacer lo que salga (sí puedes pausar o detener lo que falte).`;
    if (!confirm(pregunta)) return;
    decir('Guardando…');
    const { r, d } = await pedir('/api/admin/campanas-wa', post({ ...rv.datos, totalVisto: rv.total, programadaPara }));
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
    if (!revisarCampos()) return;
    const telefono = $('cwa-prueba-tel').value.trim();
    decir('Mandando la prueba…');
    // Sin nombre de cliente: la prueba muestra lo que ven los que no tienen nombre.
    const { r, d } = await pedir('/api/admin/campanas-wa/prueba', post({ ...datos, telefono }));
    if (!r.ok) return decir(d.error || 'No se pudo mandar la prueba', 'var(--color-danger)');
    decir('✓ Prueba mandada. Revisa tu WhatsApp.', 'var(--color-success)');
  }

  async function detener(id, programada) {
    if (!confirm(programada ? '¿Cancelar la campaña programada? No le llega a nadie.'
      : '¿Detener la campaña? Lo que ya salió no se puede regresar; a los que faltan ya no se les manda.')) return;
    const { r, d } = await pedir(`/api/admin/campanas-wa/${encodeURIComponent(id)}/detener`, post({}));
    if (!r.ok) alert(d.error || (programada ? 'No se pudo cancelar' : 'No se pudo detener'));
    await cargarHistorial();
  }

  // Pausar no cancela a nadie; reanudar vuelve a medir los rechazos desde cero.
  async function pausarOReanudar(id, acc) {
    if (acc === 'reanudar' && !confirm('¿Reanudar la campaña? Revisa antes por qué no llegaron los mensajes.')) return;
    const { r, d } = await pedir(`/api/admin/campanas-wa/${encodeURIComponent(id)}/${acc}`, post({}));
    if (!r.ok) alert(d.error || 'No se pudo cambiar la campaña');
    await cargarHistorial();
  }

  async function cargarPlantillas(recargar) {
    const sel = $('cwa-plantilla');
    sel.innerHTML = '<option value="">Leyendo tus plantillas de Meta…</option>';
    sel.disabled = true;
    const { r, d } = await pedir(`/api/admin/campanas-wa/plantillas${recargar ? '?recargar=1' : ''}`);
    if (!r.ok || !d.conectado || d.motivo) {
      E.meta = { plantillas: [] };
      pintarProgramar();
      sel.innerHTML = '<option value="">Sin plantillas</option>';
      $('cwa-conexion').innerHTML = `<div class="tnd-aviso alerta" style="margin-bottom:10px;">⚠️ <div>${esc(d.motivo || d.error || 'No se pudieron leer las plantillas')}</div></div>`;
      $('cwa-sin-plantillas').style.display = '';
      return;
    }
    E.meta = d;
    $('cwa-segmento').innerHTML = (d.segmentos || []).map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    $('cwa-dias').textContent = String(d.diasSinRepetir || 7);
    // Tanda de arranque: la de Xabor, o menos si Meta le da a este número menos al día.
    const tier = { TIER_50: 50, TIER_250: 250 }[d.numero?.limite];
    $('cwa-tope').value = String(Math.min(d.tandas?.tope24h || 250, tier || Infinity));
    $('cwa-umbral').value = String(d.tandas?.umbralPct || 10);
    pintarConexion();
    pintarProgramar();
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
          <div class="tnd-campo"><label for="cwa-segmento">¿A quién?</label><select id="cwa-segmento"></select>
            <div class="ayuda" id="cwa-a-quien">Va a los clientes de la Lista, menos quienes se dieron de baja, los teléfonos
              del negocio y los internos.</div></div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <div class="tnd-campo" style="flex:1;min-width:150px;"><label for="cwa-tope">Máximo de mensajes en 24 h</label>
              <input id="cwa-tope" type="number" inputmode="numeric" min="10" max="100000" step="1" value="250"></div>
            <div class="tnd-campo" style="flex:1;min-width:150px;"><label for="cwa-umbral">Pausar si fallan más del (%) de los envíos</label>
              <input id="cwa-umbral" type="number" inputmode="numeric" min="2" max="50" step="1" value="10"></div>
          </div>
          <label style="display:flex;gap:8px;align-items:flex-start;font-size:0.8rem;margin-bottom:14px;cursor:pointer;">
            <input type="checkbox" id="cwa-excluir" checked style="margin-top:2px;">
            <span>No mandarle a quien ya recibió una campaña en los últimos <span id="cwa-dias">7</span> días</span></label>
          <div id="cwa-programar"></div>
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
      if (acc === 'cancelar-programada') await detener(b.dataset.id, true);
      if (acc === 'pausar' || acc === 'reanudar') await pausarOReanudar(b.dataset.id, acc);
    } catch (err) {
      decir(err.message || 'Algo falló', 'var(--color-danger)');
    } finally {
      E.ocupado = false;
    }
  }

  function alCambiar(e) {
    if (!e.target.closest('#cwa-modal') || e.target.id === 'cwa-prueba-tel' || e.target.id === 'cwa-nombre') return;
    // Cuándo mandarla no cambia lo revisado: solo el botón y el calendario.
    if (e.target.name === 'cwa-modo' || e.target.id === 'cwa-cuando') {
      $('cwa-cuando-campo').style.display = programando() ? '' : 'none';
      $('cwa-cuando-error').style.display = 'none';
      textoBoton();
      return;
    }
    if (e.target.id === 'cwa-plantilla') pintarVariables();
    const caja = e.target.closest('[data-ranura]');
    if (caja) { const aviso = caja.querySelector('[data-error]'); if (aviso) aviso.style.display = 'none'; }
    if (e.target.matches('[data-fuente]')) {
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
