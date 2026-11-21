// ─── Clientes: teléfonos del negocio y marca de interno ─────────────────────
//
// Saneamiento de Clientes, fase 1 (21-nov-2026). Lo que no es un cliente (el
// WhatsApp de la sucursal, el número comodín de caja, un empleado o una
// empresa) sale de la Lista, de los segmentos, de VIP y de las campañas.
//
// Archivo aparte de index.html por la misma razón que campanas-wa.js: el
// panel es un solo <script> donde una función con nombre repetido pisa en
// silencio a la otra. Todo vive en esta IIFE y lo único global es
// `XaborClientesSaneamiento`. Botones por delegación ([data-cls-acc]), sin
// onclick en línea.
//
// Habla solo con /api/admin/clientes/telefonos-negocio y
// /api/admin/clientes/v2/:id/{interno,bitacora} (solo administradores; el
// negocio sale de la sesión: src/services/clientesSaneamientoRutas.js).
(function () {
  const E = { ocupado: false, ficha: null };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);
  const tel = t => { const d = String(t || '').replace(/\D/g, ''); return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : d; };
  const fecha = v => v ? new Date(v).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const json = (metodo, cuerpo) => ({ method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

  async function pedir(url, opciones) {
    const r = await apiFetch(url, opciones);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'No se pudo completar');
    return d;
  }

  function recargarLista() {
    if (typeof cargarClientes === 'function') cargarClientes();
  }

  // ── Ficha: sección «Interno / empresa» ───────────────────────────────────
  const ACCION = { marcar_interno: 'Se marcó como interno', quitar_interno: 'Se quitó la marca de interno' };

  function seccionFicha(c) {
    if (!c || !c.id) return '';
    E.ficha = c.id;
    const titulo = '<div style="font-size:0.72rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">Interno / empresa</div>';
    const delNegocio = c.esDelNegocio ? `<div style="font-size:0.82rem;background:#f1f5f9;border-radius:8px;padding:8px 10px;margin-bottom:8px;">
        📞 Este teléfono es <strong>del negocio</strong>: no cuenta como cliente, no está en ningún segmento y no recibe campañas.
        Se cambia en «Teléfonos del negocio».</div>` : '';
    const cuerpo = c.esInterno
      ? `<div style="font-size:0.82rem;">🏢 <strong>Marcado como interno</strong>${c.internoMotivo ? ` · ${esc(c.internoMotivo)}` : ''}.
          No está en los segmentos ni en VIP y no recibe campañas.</div>
         <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
          <input id="cls-motivo" type="text" maxlength="120" placeholder="Por qué se quita (opcional)"
            style="flex:1;min-width:160px;padding:6px 10px;border:1px solid #e5e2da;border-radius:8px;font-size:0.8rem;">
          <button type="button" data-cls-acc="quitar-interno" data-id="${esc(c.id)}"
            style="padding:6px 12px;border:1px solid #64748b;border-radius:8px;background:#fff;color:#334155;font-size:0.78rem;font-weight:700;cursor:pointer;">Quitar la marca</button></div>`
      : `<div style="font-size:0.8rem;color:#666;">Márcalo si es un empleado, un proveedor o una empresa: sale de los segmentos, de VIP y de las campañas. Sus pedidos no se tocan.</div>
         <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
          <input id="cls-motivo" type="text" maxlength="120" placeholder="Motivo: empleado, proveedor, empresa…"
            style="flex:1;min-width:160px;padding:6px 10px;border:1px solid #e5e2da;border-radius:8px;font-size:0.8rem;">
          <button type="button" data-cls-acc="marcar-interno" data-id="${esc(c.id)}"
            style="padding:6px 12px;border:1px solid #334155;border-radius:8px;background:#334155;color:#fff;font-size:0.78rem;font-weight:700;cursor:pointer;">Marcar como interno</button></div>`;
    setTimeout(() => cargarBitacora(c.id), 0);
    return `<div style="margin-top:16px;" id="cls-seccion">${titulo}${delNegocio}${cuerpo}
      <div id="cls-estado" style="font-size:0.78rem;font-weight:700;margin-top:6px;"></div>
      <div id="cls-bitacora" style="margin-top:6px;"></div></div>`;
  }

  async function cargarBitacora(id) {
    const el = $('cls-bitacora');
    if (!el || E.ficha !== id) return;
    try {
      const d = await pedir(`/api/admin/clientes/v2/${encodeURIComponent(id)}/bitacora`);
      if (E.ficha !== id || !$('cls-bitacora')) return;
      $('cls-bitacora').innerHTML = (d.cambios || []).length ? `<div style="font-size:0.72rem;color:#999;">${d.cambios.slice(0, 5).map(x =>
        `${esc(fecha(x.fecha))} · ${esc(ACCION[x.accion] || x.accion)}${x.despues?.motivo ? ` (${esc(x.despues.motivo)})` : ''}`).join('<br>')}</div>` : '';
    } catch { /* la bitácora es informativa */ }
  }

  async function cambiarInterno(id, interno) {
    const motivo = $('cls-motivo')?.value.trim() || '';
    const estado = $('cls-estado');
    if (interno && !motivo) { if (estado) { estado.style.color = '#ef4444'; estado.textContent = 'Escribe el motivo.'; } return; }
    if (estado) { estado.style.color = '#888'; estado.textContent = 'Guardando…'; }
    try {
      await pedir(`/api/admin/clientes/v2/${encodeURIComponent(id)}/interno`, json('PATCH', { interno, motivo }));
      if (typeof verFicha === 'function') await verFicha(id);
      recargarLista();
    } catch (e) {
      if ($('cls-estado')) { $('cls-estado').style.color = '#ef4444'; $('cls-estado').textContent = e.message; }
    }
  }

  // ── Teléfonos del negocio ────────────────────────────────────────────────
  function modal() {
    let m = $('cls-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'cls-modal';
    m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;align-items:center;justify-content:center;';
    m.innerHTML = `<div style="background:#fff;border-radius:16px;padding:22px;max-width:560px;width:92%;max-height:88vh;overflow-y:auto;position:relative;box-sizing:border-box;">
      <button type="button" data-cls-acc="cerrar" aria-label="Cerrar" style="position:absolute;top:12px;right:12px;border:none;background:none;font-size:1.3rem;cursor:pointer;color:#888;">✕</button>
      <div style="font-size:1.05rem;font-weight:800;margin-bottom:6px;padding-right:28px;">📞 Teléfonos del negocio</div>
      <div style="font-size:0.8rem;color:#666;margin-bottom:12px;">Estos números no son clientes: no reciben campañas, no cuentan en los
        segmentos y un pedido capturado con uno de ellos no da de alta a nadie. El WhatsApp de cada sucursal se agrega solo;
        agrega también el que use la caja cuando el cliente no da su número.</div>
      <div id="cls-telefonos"><div style="color:#aaa;text-align:center;padding:16px;">Cargando…</div></div>
      <div style="display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;">
        <input id="cls-tel-nuevo" type="tel" inputmode="numeric" maxlength="13" placeholder="10 dígitos"
          style="flex:1;min-width:120px;padding:7px 10px;border:1px solid #e5e2da;border-radius:8px;font-size:0.85rem;">
        <input id="cls-tel-etiqueta" type="text" maxlength="60" placeholder="Para qué es (ej. comodín de caja)"
          style="flex:2;min-width:160px;padding:7px 10px;border:1px solid #e5e2da;border-radius:8px;font-size:0.85rem;">
        <button type="button" data-cls-acc="agregar"
          style="padding:7px 14px;border:none;border-radius:8px;background:#FF6B35;color:#fff;font-weight:700;font-size:0.85rem;cursor:pointer;">Agregar</button>
      </div>
      <div id="cls-tel-estado" style="font-size:0.8rem;font-weight:700;margin-top:8px;"></div>
    </div>`;
    m.addEventListener('click', e => { if (e.target === m) m.style.display = 'none'; });
    document.body.appendChild(m);
    return m;
  }

  function decirTel(t, color) {
    const el = $('cls-tel-estado');
    if (el) { el.style.color = color || '#888'; el.textContent = t || ''; }
  }

  function filaTelefono(t) {
    const origen = t.origen === 'whatsapp' ? 'WhatsApp del negocio' : 'Agregado a mano';
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #f0ede8;flex-wrap:wrap;${t.activo ? '' : 'opacity:0.55;'}">
      <div style="flex:1;min-width:160px;">
        <div style="font-weight:700;font-size:0.88rem;">${esc(tel(t.telefono))}${t.activo ? '' : ' <span style="font-size:0.7rem;color:#888;">(desactivado)</span>'}</div>
        <div style="font-size:0.72rem;color:#888;">${esc(t.etiqueta || origen)} · ${esc(origen)}${t.pedidos ? ` · ${esc(t.pedidos)} pedido${t.pedidos === 1 ? '' : 's'} con este número` : ''}</div>
      </div>
      <button type="button" data-cls-acc="${t.activo ? 'desactivar' : 'activar'}" data-id="${esc(t.id)}"
        style="padding:5px 10px;border:1px solid #e5e2da;border-radius:8px;background:#fff;font-size:0.75rem;cursor:pointer;">${t.activo ? 'Desactivar' : 'Volver a activar'}</button>
    </div>`;
  }

  async function cargarTelefonos(revisarWhatsapp) {
    const el = $('cls-telefonos');
    try {
      const d = await pedir(`/api/admin/clientes/telefonos-negocio${revisarWhatsapp ? '?revisarWhatsapp=1' : ''}`);
      el.innerHTML = (d.telefonos || []).length ? d.telefonos.map(filaTelefono).join('')
        : '<div style="color:#aaa;font-size:0.82rem;padding:8px 0;">Todavía no hay teléfonos del negocio.</div>';
    } catch (e) {
      el.innerHTML = `<div style="color:#ef4444;font-size:0.82rem;">${esc(e.message)}</div>`;
    }
  }

  async function abrirTelefonos() {
    modal().style.display = 'flex';
    decirTel('');
    await cargarTelefonos(true);
  }

  async function agregar() {
    const telefono = $('cls-tel-nuevo').value.trim();
    const etiqueta = $('cls-tel-etiqueta').value.trim();
    decirTel('Guardando…');
    try {
      await pedir('/api/admin/clientes/telefonos-negocio', json('POST', { telefono, etiqueta }));
      $('cls-tel-nuevo').value = ''; $('cls-tel-etiqueta').value = '';
      decirTel('✓ Agregado. Ya no cuenta como cliente.', '#16a34a');
      await cargarTelefonos(false);
      recargarLista();
    } catch (e) { decirTel(e.message, '#ef4444'); }
  }

  async function cambiarTelefono(id, activo) {
    decirTel('Guardando…');
    try {
      await pedir(`/api/admin/clientes/telefonos-negocio/${encodeURIComponent(id)}`, json('PATCH', { activo }));
      decirTel(activo ? '✓ Activado.' : '✓ Desactivado: vuelve a contar como cliente.', '#16a34a');
      await cargarTelefonos(false);
      recargarLista();
    } catch (e) { decirTel(e.message, '#ef4444'); }
  }

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-cls-acc]');
    if (!b || b.disabled) return;
    const acc = b.dataset.clsAcc;
    if (acc === 'cerrar') { modal().style.display = 'none'; return; }
    if (E.ocupado) return;
    E.ocupado = true;
    try {
      if (acc === 'telefonos') await abrirTelefonos();
      if (acc === 'agregar') await agregar();
      if (acc === 'desactivar' || acc === 'activar') await cambiarTelefono(b.dataset.id, acc === 'activar');
      if (acc === 'marcar-interno' || acc === 'quitar-interno') await cambiarInterno(b.dataset.id, acc === 'marcar-interno');
    } finally {
      E.ocupado = false;
    }
  });

  window.XaborClientesSaneamiento = { seccionFicha };
})();
