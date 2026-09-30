// Renderizador puro y de solo lectura; no contiene fetch, tokens ni handlers
// de compra. Abrir <details> jamás ejecuta el formulario del cliente.
(function(root) {
  const esc=v=>String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fecha=v=>{const d=new Date(v);return v && Number.isFinite(d.getTime())
    ?new Intl.DateTimeFormat('es-MX',{dateStyle:'short',timeStyle:'short'}).format(d):'';};
  const importe=v=>Number.isFinite(Number(v))?new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(Number(v)):'';
  function seguimiento(s) {
    if(!s)return '';
    return `<section aria-label="Seguimiento del formulario" style="background:#f0f6f3;border-radius:8px;padding:10px;margin:10px 0;font-size:.82rem;line-height:1.5">
      <strong>${esc(s.titulo)}</strong>
      ${s.paso?`<div>Último paso observado: ${esc(s.paso)}</div>`:''}
      ${s.ultimaActividad?`<div>Actividad: ${esc(fecha(s.ultimaActividad))}</div>`:''}
      ${s.borradorGuardado?`<div>Borrador guardado: ${esc(fecha(s.borradorGuardado))}</div>`:''}
      ${s.incidencias?'<div>Hay validaciones o errores reportados en el formulario.</div>':''}
      ${s.sugerirAyuda?'<div style="margin-top:6px;font-weight:600">Conviene ofrecer ayuda; no hay abandono confirmado.</div>':''}
      <div style="opacity:.75;margin-top:6px">${esc(s.aclaracion)}</div>
    </section>`;
  }
  function formulario(v) {
    if(!v)return '';
    return `<details data-form-detalle="enviado" style="margin-top:10px;font-size:.85rem">
      <summary style="cursor:pointer;font-weight:600">Ver formulario enviado</summary>
      <div style="margin:8px 0;color:#666">${esc(v.alcance)}. Vista de solo lectura, no es la pantalla en vivo del cliente.</div>
      ${v.totalProductos>v.productos?.length?`<p>Vista parcial: ${esc(v.productos.length)} de ${esc(v.totalProductos)} productos de la versión enviada.</p>`:''}
      ${(v.productos || []).map((p,i)=>`<details data-form-detalle="producto-${i}" style="padding:8px 0;border-top:1px solid #ddd">
        <summary style="cursor:pointer">${esc(p.nombre)}${p.precio===null?'':` · ${esc(importe(p.precio))} base`}</summary>
        ${(p.grupos || []).map(g=>`<div style="margin-top:8px"><strong>${esc(g.nombre)}</strong>
          <div>${esc(g.minimo)} a ${esc(g.maximo)} opciones</div>
          <ul style="margin:4px 0;padding-left:20px">${(g.opciones || []).map(o=>`<li>${esc(o.nombre)}${o.extra?` (+${esc(importe(o.extra))})`:''}</li>`).join('')}</ul></div>`).join('')}
      </details>`).join('')}
      ${v.modalidades?.length?`<p><strong>Entrega:</strong> ${esc(v.modalidades.join(' · '))}</p>`:''}
      ${v.pagos?.length?`<p><strong>Pago:</strong> ${esc(v.pagos.join(' · '))}</p>`:''}
    </details>`;
  }
  function transporte(s) {
    return s?`<span title="${esc(s.aclaracion)}" style="margin-left:6px;${s.codigo==='failed'?'color:#ad2525':s.codigo==='read'?'color:#147da6':''}">${esc(s.titulo)}${s.errorCodigo!==null && s.errorCodigo!==undefined?` (${esc(s.errorCodigo)})`:''}</span>`:'';
  }
  function respuesta(r) {
    if(!r)return '';
    return `<details data-form-detalle="recibida" style="margin-top:10px;font-size:.85rem"><summary style="cursor:pointer;font-weight:600">Ver respuesta recibida</summary>
      <p>${esc(r.aclaracion)}</p>${(r.lineas || []).map(l=>`<div style="border-top:1px solid #ddd;padding:8px 0"><strong>${esc(l.cantidad)} × ${esc(l.nombre)}</strong>
      ${l.opciones.map(o=>`<div>${esc(o)}</div>`).join('')}${l.nota?`<div>Nota: ${esc(l.nota)}</div>`:''}</div>`).join('')}</details>`;
  }
  function conservarAbiertos(previo,nuevo) {
    const abiertos=new Set([...previo?.querySelectorAll('details[data-form-detalle][open]') || []].map(d=>d.dataset.formDetalle));
    for(const d of nuevo.querySelectorAll('details[data-form-detalle]'))if(abiertos.has(d.dataset.formDetalle))d.open=true;
  }
  root.FormulariosChat=Object.freeze({seguimiento,formulario,respuesta,transporte,conservarAbiertos});
})(typeof window==='undefined'?globalThis:window);
