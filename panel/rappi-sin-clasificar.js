// Menú → Rappi → «Opciones sin clasificar» (Fase 2.2, 23-nov-2026).
//
// Lo que llegó de Rappi y no se pudo emparejar con el menú de Xabor: un
// producto que no se encontró, o una opción («Pechuga de pollo») que no está
// en los grupos de ese producto. El administrador elige a qué corresponde; el
// servidor lo guarda para este negocio y rehace el registro de esos pedidos.
// La venta, la comanda y el ticket no cambian.
//
// Solo aparece con la bandera `lineas_estructuradas` encendida. Todo lo que
// viene del servidor se pinta con textContent: los nombres de Rappi los
// escribe otra empresa.
(function (global) {
  'use strict';

  const ID = 'rappi-sin-clasificar';
  const api = (url, opts) => (global.apiFetch || global.fetch)(url, opts);

  function el(tag, estilo, texto) {
    const n = document.createElement(tag);
    if (estilo) n.style.cssText = estilo;
    if (texto !== undefined && texto !== null) n.textContent = String(texto);
    return n;
  }

  function opcionSelect(valor, texto) {
    const o = document.createElement('option');
    o.value = String(valor);
    o.textContent = texto;
    return o;
  }

  const ESTILO_FILA = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;border-top:1px solid #f1f0ed;';
  const ESTILO_SELECT = 'flex:1;min-width:180px;border:1px solid #e5e2da;border-radius:8px;padding:7px 10px;font-size:0.85rem;background:#fff;';
  const ESTILO_BOTON = 'background:#1c1c1c;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:0.82rem;font-weight:700;cursor:pointer;';

  async function guardar(cuerpo, fb, boton) {
    boton.disabled = true;
    fb.textContent = 'Guardando…';
    fb.style.color = '#888';
    try {
      const r = await api('/api/admin/lineas/rappi/emparejamientos', { method: 'PUT', body: JSON.stringify(cuerpo) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { fb.textContent = d.error || 'No se pudo guardar'; fb.style.color = '#ef4444'; boton.disabled = false; return; }
      fb.textContent = `Guardado. Pedidos actualizados: ${Number(d.rehechos) || 0}.`;
      fb.style.color = '#16a34a';
      setTimeout(cargar, 900);
    } catch (e) {
      fb.textContent = 'Error de conexión';
      fb.style.color = '#ef4444';
      boton.disabled = false;
    }
  }

  function filaProducto(p, menu) {
    const fila = el('div', ESTILO_FILA);
    fila.appendChild(el('div', 'flex:1 1 100%;font-size:0.85rem;font-weight:700;', `${p.producto_rappi}`));
    fila.appendChild(el('div', 'flex:1 1 100%;font-size:0.76rem;color:#888;', `Producto de Rappi sin emparejar · ${p.veces} vez/veces`));
    const sel = el('select', ESTILO_SELECT);
    sel.appendChild(opcionSelect('', 'Elige el producto del menú…'));
    for (const m of menu) sel.appendChild(opcionSelect(m.id, m.nombre));
    const boton = el('button', ESTILO_BOTON, 'Guardar');
    const fb = el('div', 'flex:1 1 100%;font-size:0.78rem;');
    boton.type = 'button';
    boton.onclick = () => {
      if (!sel.value) { fb.textContent = 'Elige un producto'; fb.style.color = '#ef4444'; return; }
      guardar({ producto_rappi: p.producto_rappi, producto_id: Number(sel.value) }, fb, boton);
    };
    fila.append(sel, boton, fb);
    return fila;
  }

  function filaOpcion(o) {
    const fila = el('div', ESTILO_FILA);
    fila.appendChild(el('div', 'flex:1 1 100%;font-size:0.85rem;font-weight:700;', `${o.producto_rappi} › ${o.opcion_rappi}`));
    fila.appendChild(el('div', 'flex:1 1 100%;font-size:0.76rem;color:#888;',
      `En el menú: ${o.producto || 'producto ' + o.producto_id} · ${o.veces} vez/veces`));
    const sel = el('select', ESTILO_SELECT);
    sel.appendChild(opcionSelect('', o.elegibles.length ? 'Elige la opción…' : 'Este producto no tiene opciones en el menú'));
    for (const e of o.elegibles) sel.appendChild(opcionSelect(e.opcion_id, e.texto));
    const boton = el('button', ESTILO_BOTON, 'Guardar');
    const fb = el('div', 'flex:1 1 100%;font-size:0.78rem;');
    boton.type = 'button';
    boton.disabled = !o.elegibles.length;
    boton.onclick = () => {
      if (!sel.value) { fb.textContent = 'Elige una opción'; fb.style.color = '#ef4444'; return; }
      guardar({ producto_rappi: o.producto_rappi, opcion_rappi: o.opcion_rappi, producto_id: o.producto_id,
        opcion_id: Number(sel.value) }, fb, boton);
    };
    fila.append(sel, boton, fb);
    return fila;
  }

  function filaEmparejado(e) {
    const fila = el('div', ESTILO_FILA);
    const destino = e.opcion ? `${e.producto} › ${e.grupo}: ${e.opcion}` : e.producto;
    fila.appendChild(el('div', 'flex:1;min-width:200px;font-size:0.8rem;color:#374151;',
      `${e.opcion_rappi ? `${e.producto_rappi} › ${e.opcion_rappi}` : e.producto_rappi} → ${destino}`));
    const boton = el('button', 'background:none;border:1px solid #e5e2da;border-radius:8px;padding:5px 10px;font-size:0.78rem;cursor:pointer;', 'Quitar');
    const fb = el('div', 'flex:1 1 100%;font-size:0.78rem;');
    boton.type = 'button';
    boton.onclick = async () => {
      if (!global.confirm('¿Quitar este emparejamiento? Esos pedidos vuelven a «Sin clasificar».')) return;
      boton.disabled = true;
      try {
        const r = await api(`/api/admin/lineas/rappi/emparejamientos/${Number(e.id)}`, { method: 'DELETE' });
        if (!r.ok) { const d = await r.json().catch(() => ({})); fb.textContent = d.error || 'No se pudo quitar'; fb.style.color = '#ef4444'; boton.disabled = false; return; }
        cargar();
      } catch (err) { fb.textContent = 'Error de conexión'; fb.style.color = '#ef4444'; boton.disabled = false; }
    };
    fila.append(boton, fb);
    return fila;
  }

  function pintar(cont, d) {
    cont.replaceChildren();
    if (!d || !d.activo) { cont.style.display = 'none'; return; }
    cont.style.display = '';
    cont.appendChild(el('div', 'font-size:0.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:6px;',
      'Opciones de Rappi sin clasificar'));
    cont.appendChild(el('div', 'font-size:0.8rem;color:#888;margin-bottom:8px;line-height:1.4;',
      'Lo que llegó de Rappi y no coincide con el menú de Xabor. Elige a qué corresponde: se usa para los reportes; la comanda y el ticket no cambian.'));
    const pendientes = d.productos.length + d.opciones.length;
    if (!pendientes) cont.appendChild(el('div', 'font-size:0.85rem;color:#16a34a;padding:6px 0;', 'Todo lo de Rappi está clasificado.'));
    for (const p of d.productos) cont.appendChild(filaProducto(p, d.menu || []));
    for (const o of d.opciones) cont.appendChild(filaOpcion(o));
    if (d.emparejamientos.length) {
      cont.appendChild(el('div', 'font-size:0.78rem;font-weight:700;color:#999;margin:12px 0 2px;', 'Ya emparejados a mano'));
      for (const e of d.emparejamientos) cont.appendChild(filaEmparejado(e));
    }
  }

  async function cargar() {
    const cont = document.getElementById(ID);
    if (!cont) return;
    try {
      const r = await api('/api/admin/lineas/rappi/sin-clasificar');
      if (!r.ok) { cont.style.display = 'none'; return; }
      pintar(cont, await r.json());
    } catch (e) {
      cont.style.display = 'none';
    }
  }

  global.XaborRappiSinClasificar = { cargar, pintar };
})(typeof window !== 'undefined' ? window : globalThis);
