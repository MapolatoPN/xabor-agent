// ─── Editor del banner de la tienda en línea (Panel → Tienda → Banner) ─────
//
// Archivo aparte de index.html a propósito: el panel es un solo <script> de
// miles de líneas donde una función con nombre repetido pisa en silencio a la
// otra. Todo vive dentro de esta IIFE y lo único global es
// `XaborBannerTienda`. Los botones usan delegación de eventos, sin onclick
// en línea, para no necesitar más nombres globales.
//
// Habla solo con /api/admin/tienda/banner (src/services/tiendaRutasCore.js);
// el servidor vuelve a validar todo (src/services/tiendaBanner.js).
(function () {
  const MAX_MB = 8;
  const E = { diapositivas: [], productos: [], max: 5, largos: {}, tema: 'clasico', slug: '', portada: null, sucio: false, cont: null };

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const L = campo => Number(E.largos[campo]) || 200;

  function estilos() {
    if (document.getElementById('tbn-estilos')) return;
    const s = document.createElement('style');
    s.id = 'tbn-estilos';
    s.textContent = `
      .tbn-dia { border:1px solid var(--color-border); border-radius:var(--radius-lg); padding:14px; margin-bottom:12px; background:var(--color-surface); }
      .tbn-dia.pausada { opacity:.72; }
      .tbn-cab { display:flex; align-items:center; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
      .tbn-cab h4 { margin:0; font-size:0.86rem; font-weight:800; flex:1; min-width:120px; }
      .tbn-estado { font-size:0.72rem; font-weight:700; padding:3px 9px; border-radius:999px; background:var(--color-success-light); color:#047857; }
      .tbn-estado.pausada { background:var(--color-surface-2); color:var(--color-text-secondary); }
      .tbn-estado.fuera { background:var(--color-warning-light); color:#b45309; }
      .tbn-foto { display:flex; gap:12px; align-items:center; margin-bottom:13px; flex-wrap:wrap; }
      .tbn-mini { width:150px; height:84px; border-radius:var(--radius-md); background:var(--color-surface-2); border:1px solid var(--color-border); flex-shrink:0; display:grid; place-items:center; font-size:0.72rem; color:var(--color-text-muted); overflow:hidden; }
      .tbn-mini img { width:100%; height:100%; object-fit:cover; display:block; }
      .tbn-foto-acc { display:flex; flex-direction:column; gap:6px; flex:1; min-width:200px; }
      .tbn-foto-acc .tbn-fila-btn { display:flex; gap:6px; flex-wrap:wrap; }
      .tbn-pie { display:flex; gap:9px; align-items:center; flex-wrap:wrap; margin-top:4px; }
      .tbn-sucio { font-size:0.78rem; color:#b45309; font-weight:700; }
    `;
    document.head.appendChild(s);
  }

  const hoyLocal = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  function estadoDe(d) {
    if (d.activo === false) return ['pausada', 'Pausada'];
    const hoy = hoyLocal();
    if (d.desde && hoy < d.desde) return ['fuera', `Se muestra desde el ${d.desde}`];
    if (d.hasta && hoy > d.hasta) return ['fuera', `Terminó el ${d.hasta}`];
    return ['', 'Visible'];
  }

  function nueva(base = {}) {
    return {
      activo: true, ceja: '', titulo: '', texto: '', boton: '',
      destino: { tipo: 'menu' }, foto: null, fotoUrl: null, desde: null, hasta: null, ...base,
    };
  }

  function opcionesDestino(d) {
    const sel = d.destino?.tipo === 'producto' ? Number(d.destino.productoId) : 0;
    const publicados = E.productos.filter(p => p.publicado || p.id === sel);
    const porCat = {};
    for (const p of publicados) (porCat[p.categoria || 'Otros'] ||= []).push(p);
    return `<option value="0"${sel ? '' : ' selected'}>El menú completo</option>` +
      Object.entries(porCat).map(([cat, ps]) => `<optgroup label="${esc(cat)}">${ps.map(p =>
        `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.nombre)}${p.publicado ? '' : ' (no publicado)'}</option>`).join('')}</optgroup>`).join('');
  }

  function tarjeta(d, i) {
    const [clase, texto] = estadoDe(d);
    const n = E.diapositivas.length;
    const url = d.foto?.tipo === 'url' ? d.foto.url : '';
    return `<div class="tbn-dia${d.activo === false ? ' pausada' : ''}" data-i="${i}">
      <div class="tbn-cab">
        <h4>Diapositiva ${i + 1}</h4>
        <span class="tbn-estado ${clase}">${esc(texto)}</span>
        <button class="tnd-btn sec chico" data-acc="activo">${d.activo === false ? 'Mostrar' : 'Pausar'}</button>
        <button class="tnd-btn sec chico" data-acc="subir" ${i === 0 ? 'disabled' : ''} title="Mover antes" aria-label="Mover antes">↑</button>
        <button class="tnd-btn sec chico" data-acc="bajar" ${i === n - 1 ? 'disabled' : ''} title="Mover después" aria-label="Mover después">↓</button>
        <button class="tnd-btn peligro chico" data-acc="quitar">Quitar</button>
      </div>
      <div class="tbn-foto">
        <div class="tbn-mini">${d.fotoUrl
          ? `<img src="${esc(d.fotoUrl)}" alt="" onerror="this.replaceWith('No se pudo cargar')">` : 'Sin foto'}</div>
        <div class="tbn-foto-acc">
          <div class="tbn-fila-btn">
            <button class="tnd-btn sec chico" data-acc="foto">📷 ${d.fotoUrl ? 'Cambiar foto' : 'Subir foto'}</button>
            ${d.fotoUrl ? '<button class="tnd-btn sec chico" data-acc="sin-foto">Quitar foto</button>' : ''}
            <span class="tbn-subiendo" style="font-size:0.75rem;color:var(--color-text-secondary);"></span>
          </div>
          <input class="tbn-url" data-campo="url" maxlength="${L('url')}" value="${esc(url)}" placeholder="…o pega la liga de una imagen (https://)"
            style="width:100%;padding:7px 10px;border:1px solid var(--color-border-strong);border-radius:var(--radius-md);font-size:0.78rem;">
          <div class="ayuda" style="font-size:0.72rem;color:var(--color-text-muted);">Foto horizontal, de preferencia. JPG, PNG o WEBP de hasta ${MAX_MB} MB.</div>
        </div>
      </div>
      <div class="tnd-campo"><label>Texto pequeño de arriba</label>
        <input data-campo="ceja" maxlength="${L('ceja')}" value="${esc(d.ceja)}" placeholder="De temporada"></div>
      <div class="tnd-campo"><label>Título</label>
        <textarea data-campo="titulo" rows="2" maxlength="${L('titulo')}" placeholder="Pozole rojo&#10;solo en septiembre">${esc(d.titulo)}</textarea>
        <div class="ayuda">Obligatorio. Con Enter pasas a un segundo renglón.</div></div>
      <div class="tnd-campo"><label>Descripción</label>
        <input data-campo="texto" maxlength="${L('texto')}" value="${esc(d.texto)}" placeholder="Con tostadas, rábano y orégano.">
        <div class="ayuda">En celular no se muestra: que el título se entienda solo.</div></div>
      <div class="tnd-fila">
        <div class="tnd-campo"><label>Texto del botón</label>
          <input data-campo="boton" maxlength="${L('boton')}" value="${esc(d.boton)}" placeholder="${d.destino?.tipo === 'producto' ? 'Ordenar' : 'Explorar el menú'}"></div>
        <div class="tnd-campo"><label>El botón lleva a</label>
          <select data-campo="destino">${opcionesDestino(d)}</select></div>
      </div>
      <div class="tnd-fila">
        <div class="tnd-campo"><label>Mostrar desde</label>
          <input type="date" data-campo="desde" value="${esc(d.desde || '')}"></div>
        <div class="tnd-campo"><label>Hasta</label>
          <input type="date" data-campo="hasta" value="${esc(d.hasta || '')}"></div>
      </div>
      <div class="ayuda" style="font-size:0.72rem;color:var(--color-text-muted);margin-top:-6px;">Sin fechas se muestra siempre. «Hasta» incluye ese día completo.</div>
    </div>`;
  }

  function pintar() {
    const cont = E.cont;
    if (!cont) return;
    const liga = E.slug ? `${location.origin}/t/${encodeURIComponent(E.slug)}` : '';
    const n = E.diapositivas.length;
    cont.innerHTML = `
      ${E.tema !== 'v2' ? `<div class="tnd-aviso alerta">⚠️ <div>Tu tienda usa el diseño clásico, que no muestra este banner.
        Lo que guardes aquí aparece cuando se active el diseño nuevo.</div></div>` : ''}
      <div class="tnd-card">
        <h3>Banner de tu tienda</h3>
        <div class="sub">Las fotos grandes de arriba de tu tienda. Con dos o más, pasan solas cada pocos segundos y
          el cliente también las desliza con el dedo. Úsalas para platillos de temporada, promociones o novedades.
          Al guardar, el cambio se ve de inmediato.</div>
        ${n ? '' : `<div class="tnd-aviso info">💡 <div>Hoy tu tienda muestra la portada de siempre
          («Tu mañana, a tu gusto»). Agrega una diapositiva para poner tu propio título y tus fotos.</div></div>`}
        <div id="tbn-lista">${E.diapositivas.map(tarjeta).join('')}</div>
        <div class="tbn-pie">
          ${n ? '' : `<button class="tnd-btn sec" data-acc="desde-portada">Empezar con la portada actual</button>`}
          <button class="tnd-btn sec" data-acc="agregar" ${n >= E.max ? 'disabled' : ''}>+ Agregar diapositiva</button>
          <span style="font-size:0.75rem;color:var(--color-text-muted);">${n} de ${E.max}</span>
        </div>
      </div>
      <div class="tbn-pie">
        <button class="tnd-btn" data-acc="guardar">Guardar banner</button>
        ${liga ? `<a class="tnd-btn sec" href="${esc(liga)}" target="_blank" rel="noopener" style="text-decoration:none;">Ver mi tienda ↗</a>` : ''}
        <span id="tbn-estado" style="font-size:0.8rem;">${E.sucio ? '<span class="tbn-sucio">Tienes cambios sin guardar</span>' : ''}</span>
      </div>
      <input type="file" id="tbn-archivo" accept="image/jpeg,image/png,image/webp" style="display:none">`;
  }

  function marcarSucio() {
    if (E.sucio) return;
    E.sucio = true;
    const est = document.getElementById('tbn-estado');
    if (est) est.innerHTML = '<span class="tbn-sucio">Tienes cambios sin guardar</span>';
  }

  // Edición en el lugar: escribir no repinta (no se pierde el foco).
  function alEscribir(e) {
    const campo = e.target?.dataset?.campo;
    const caja = e.target.closest('.tbn-dia');
    if (!campo || !caja) return;
    const d = E.diapositivas[Number(caja.dataset.i)];
    if (!d) return;
    const v = e.target.value;
    if (campo === 'url') {
      const url = v.trim();
      d.foto = url ? { tipo: 'url', url } : null;
      d.fotoUrl = /^https:\/\//i.test(url) ? url : null;
      if (e.type === 'change') pintar();
    } else if (campo === 'destino') {
      const id = Number(v);
      d.destino = id ? { tipo: 'producto', productoId: id } : { tipo: 'menu' };
      if (e.type === 'change') pintar();
    } else if (campo === 'desde' || campo === 'hasta') {
      d[campo] = v || null;
      if (e.type === 'change') pintar();
    } else {
      d[campo] = v;
    }
    marcarSucio();
  }

  let fotoPara = null;
  async function subirFoto(archivo) {
    const i = fotoPara;
    fotoPara = null;
    const d = E.diapositivas[i];
    if (!archivo || !d) return;
    const aviso = E.cont.querySelector(`.tbn-dia[data-i="${i}"] .tbn-subiendo`);
    const decir = t => { if (aviso) aviso.textContent = t; };
    if (archivo.size > MAX_MB * 1024 * 1024) return decir(`La foto pesa más de ${MAX_MB} MB.`);
    decir('Subiendo…');
    try {
      const base64 = await new Promise((ok, mal) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1] || '');
        r.onerror = () => mal(new Error('No se pudo leer la foto'));
        r.readAsDataURL(archivo);
      });
      const r = await apiFetch('/api/admin/tienda/banner/foto', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, filename: archivo.name }),
      });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.error || 'No se pudo subir la foto');
      d.foto = { tipo: 'subida', id: res.id };
      d.fotoUrl = res.url;
      marcarSucio();
      pintar();
    } catch (e) {
      decir(e.message);
    }
  }

  async function guardar() {
    const est = document.getElementById('tbn-estado');
    const decir = (t, color) => { if (est) { est.style.color = color; est.textContent = t; } };
    const vacia = E.diapositivas.findIndex(d => !String(d.titulo || '').trim());
    if (vacia >= 0) return decir(`La diapositiva ${vacia + 1} necesita un título.`, 'var(--color-danger)');
    decir('Guardando…', 'var(--color-text-secondary)');
    try {
      const diapositivas = E.diapositivas.map(({ fotoUrl, ...d }) => d);
      const r = await apiFetch('/api/admin/tienda/banner', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diapositivas }),
      });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.error || 'No se pudo guardar');
      E.diapositivas = (res.diapositivas || []).map(d => nueva(d));
      E.sucio = false;
      pintar();
      const est2 = document.getElementById('tbn-estado');
      if (est2) { est2.style.color = 'var(--color-success)'; est2.textContent = '✓ Guardado'; }
      setTimeout(() => { const x = document.getElementById('tbn-estado'); if (x && !E.sucio) x.textContent = ''; }, 2500);
    } catch (e) {
      decir(e.message, 'var(--color-danger)');
    }
  }

  function alClic(e) {
    const b = e.target.closest('[data-acc]');
    if (!b || b.disabled) return;
    const acc = b.dataset.acc;
    const caja = b.closest('.tbn-dia');
    const i = caja ? Number(caja.dataset.i) : -1;
    const L2 = E.diapositivas;
    if (acc === 'guardar') return guardar();
    if (acc === 'agregar' && L2.length < E.max) L2.push(nueva());
    else if (acc === 'desde-portada') {
      L2.push(nueva({
        ceja: 'Hecho para disfrutar', titulo: 'Tu mañana,\na tu gusto.',
        texto: 'Elige tu desayuno favorito y prepáralo a tu manera.', boton: 'Explorar el menú',
        foto: E.portada ? { tipo: 'url', url: E.portada } : null, fotoUrl: E.portada || null,
      }));
    } else if (acc === 'quitar') {
      if (!confirm(`¿Quitar la diapositiva ${i + 1}?`)) return;
      L2.splice(i, 1);
    } else if (acc === 'subir' && i > 0) [L2[i - 1], L2[i]] = [L2[i], L2[i - 1]];
    else if (acc === 'bajar' && i < L2.length - 1) [L2[i + 1], L2[i]] = [L2[i], L2[i + 1]];
    else if (acc === 'activo') L2[i].activo = L2[i].activo === false;
    else if (acc === 'sin-foto') { L2[i].foto = null; L2[i].fotoUrl = null; }
    else if (acc === 'foto') {
      fotoPara = i;
      const inp = document.getElementById('tbn-archivo');
      inp.value = '';
      inp.click();
      return;
    } else return;
    marcarSucio();
    pintar();
  }

  async function abrir(cont) {
    estilos();
    if (E.cont !== cont) {
      E.cont = cont;
      cont.addEventListener('click', alClic);
      cont.addEventListener('input', alEscribir);
      cont.addEventListener('change', e => {
        if (e.target?.id === 'tbn-archivo') return subirFoto(e.target.files?.[0]);
        alEscribir(e);
      });
    }
    // Volver a la pestaña con cambios sin guardar no los pisa.
    if (E.sucio) return pintar();
    cont.innerHTML = '<div class="tnd-card">Cargando…</div>';
    try {
      const [r, rp] = await Promise.all([
        apiFetch('/api/admin/tienda/banner'),
        apiFetch('/api/admin/tienda/productos'),
      ]);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo cargar el banner');
      const p = rp.ok ? await rp.json().catch(() => ({})) : {};
      Object.assign(E, {
        diapositivas: (d.diapositivas || []).map(x => nueva(x)),
        max: d.maxDiapositivas || 5, largos: d.largos || {}, tema: d.tema, slug: d.slug,
        portada: d.portada || null, productos: p.productos || [], sucio: false,
      });
      pintar();
    } catch (e) {
      cont.innerHTML = `<div class="tnd-aviso alerta">⚠️ <div>${esc(e.message)}</div></div>`;
    }
  }

  window.XaborBannerTienda = { abrir };
})();
