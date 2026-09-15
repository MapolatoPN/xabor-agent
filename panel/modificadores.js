// Modal de modificadores compartido por POS (index.html) y Mesas
// (mesas.html). Una sola implementación: si mañana cambia la UX, cambia en
// los dos lados a la vez.
//
// El modal SOLO recoge la selección y muestra un precio de referencia. El
// precio real y la validación definitiva los hace el servidor
// (src/services/modificadores.js): aquí las reglas se aplican para no dejar
// pedir algo inválido, no como control de seguridad.
(function (global) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2);

  function tieneModificadores(producto) {
    return Array.isArray(producto?.modificadores) && producto.modificadores.length > 0;
  }

  function reglasGrupo(g) {
    const minimo = g.requerido ? Math.max(1, Number(g.minimo) || 1) : (Number(g.minimo) || 0);
    const maximo = Number(g.maximo) > 0 ? Number(g.maximo) : Infinity;
    return { minimo, maximo, multiple: maximo > 1 };
  }

  function textoRegla(g) {
    const { minimo, maximo } = reglasGrupo(g);
    if (maximo === Infinity) return minimo > 0 ? `Elige al menos ${minimo}` : 'Opcional';
    if (minimo === maximo) return `Elige ${minimo}`;
    if (minimo === 0) return `Elige hasta ${maximo}`;
    return `Elige ${minimo}–${maximo}`;
  }

  function asegurarNodo() {
    let dlg = document.getElementById('xb-mods-dlg');
    if (dlg) return dlg;
    const estilo = document.createElement('style');
    estilo.textContent = `
      #xb-mods-dlg { border:none; border-radius:14px; padding:0; width:min(460px,94vw); max-height:88vh; color:inherit; }
      #xb-mods-dlg::backdrop { background:rgba(0,0,0,.55); }
      #xb-mods-caja { background:#fff; color:#111827; display:flex; flex-direction:column; max-height:88vh; }
      #xb-mods-dlg.oscuro #xb-mods-caja { background:#1f2937; color:#f9fafb; }
      #xb-mods-head { padding:14px 16px; border-bottom:1px solid rgba(128,128,128,.3); }
      #xb-mods-head h3 { margin:0; font-size:17px; }
      #xb-mods-head p { margin:2px 0 0; font-size:13px; opacity:.7; }
      #xb-mods-body { padding:12px 16px; overflow-y:auto; flex:1; }
      .xb-grupo { margin-bottom:14px; }
      .xb-grupo h4 { margin:0 0 2px; font-size:14px; }
      .xb-grupo .xb-regla { font-size:12px; opacity:.7; margin-bottom:6px; }
      .xb-grupo .xb-regla.falta { color:#b45309; font-weight:700; }
      .xb-op { display:flex; align-items:center; gap:9px; padding:7px 4px; border-radius:8px; cursor:pointer; font-size:14px; }
      .xb-op:hover { background:rgba(128,128,128,.12); }
      .xb-op input { width:16px; height:16px; margin:0; flex:none; }
      .xb-op .xb-extra { margin-left:auto; font-size:13px; opacity:.8; }
      .xb-op.deshabilitada { opacity:.45; cursor:not-allowed; }
      #xb-mods-foot { padding:12px 16px; border-top:1px solid rgba(128,128,128,.3); display:flex; align-items:center; gap:10px; }
      #xb-mods-cant { display:flex; align-items:center; gap:8px; }
      #xb-mods-cant button { width:30px; height:30px; border-radius:8px; border:1px solid rgba(128,128,128,.4); background:transparent; color:inherit; font-size:17px; font-weight:700; cursor:pointer; }
      #xb-mods-agregar { flex:1; padding:11px; border:none; border-radius:10px; background:#f97316; color:#fff; font-weight:800; font-size:15px; cursor:pointer; }
      #xb-mods-agregar:disabled { opacity:.5; cursor:not-allowed; }
      #xb-mods-cancelar { background:transparent; border:none; color:inherit; opacity:.7; cursor:pointer; font-size:14px; }
    `;
    document.head.appendChild(estilo);
    dlg = document.createElement('dialog');
    dlg.id = 'xb-mods-dlg';
    dlg.innerHTML = `
      <div id="xb-mods-caja">
        <div id="xb-mods-head"><h3 id="xb-mods-titulo"></h3><p id="xb-mods-precio"></p></div>
        <div id="xb-mods-body"></div>
        <div id="xb-mods-foot">
          <div id="xb-mods-cant">
            <button type="button" id="xb-mods-menos" aria-label="Quitar uno">−</button>
            <span id="xb-mods-num">1</span>
            <button type="button" id="xb-mods-mas" aria-label="Agregar uno">+</button>
          </div>
          <button type="button" id="xb-mods-cancelar">Cancelar</button>
          <button type="button" id="xb-mods-agregar">Agregar</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    return dlg;
  }

  // abrirModal(producto, { oscuro }) → Promise<null | { cantidad,
  //   modificadores: [ids], detalle: [{grupo,opcion,precio_extra}],
  //   precioUnitario, texto }>
  function abrirModal(producto, opciones = {}) {
    const dlg = asegurarNodo();
    dlg.classList.toggle('oscuro', !!opciones.oscuro);
    const grupos = producto.modificadores || [];
    const seleccion = new Map(grupos.map(g => [g.id, new Set()]));
    let cantidad = 1;

    const precioBase = Number(producto.precio) || 0;
    const detalle = () => grupos.flatMap(g => [...seleccion.get(g.id)].map(oid => {
      const o = g.opciones.find(x => x.id === oid);
      return { grupo_id: g.id, grupo: g.nombre, opcion_id: o.id, opcion: o.nombre, precio_extra: Number(o.precio_extra) || 0 };
    }));
    const precioUnitario = () => precioBase + detalle().reduce((s, d) => s + d.precio_extra, 0);
    const cumple = () => grupos.every(g => {
      const { minimo, maximo } = reglasGrupo(g);
      const n = seleccion.get(g.id).size;
      return n >= minimo && n <= maximo;
    });

    document.getElementById('xb-mods-titulo').textContent = producto.nombre;
    const body = document.getElementById('xb-mods-body');
    const btnAgregar = document.getElementById('xb-mods-agregar');

    function pintar() {
      body.innerHTML = grupos.map(g => {
        const { minimo, maximo, multiple } = reglasGrupo(g);
        const n = seleccion.get(g.id).size;
        const falta = n < minimo || n > maximo;
        return `
          <div class="xb-grupo" data-grupo="${g.id}">
            <h4>${esc(g.nombre)}${g.requerido ? ' *' : ''}</h4>
            <div class="xb-regla${falta ? ' falta' : ''}">${textoRegla(g)}</div>
            ${(g.opciones || []).map(o => {
              const elegida = seleccion.get(g.id).has(o.id);
              const bloqueada = !elegida && multiple && n >= maximo;
              return `
              <label class="xb-op${bloqueada ? ' deshabilitada' : ''}">
                <input type="${multiple ? 'checkbox' : 'radio'}" name="xb-g-${g.id}" value="${o.id}" ${elegida ? 'checked' : ''} ${bloqueada ? 'disabled' : ''}>
                <span>${esc(o.nombre)}</span>
                ${Number(o.precio_extra) > 0 ? `<span class="xb-extra">+${money(o.precio_extra)}</span>` : ''}
              </label>`;
            }).join('')}
          </div>`;
      }).join('');
      body.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', () => {
          const gid = Number(input.closest('.xb-grupo').dataset.grupo);
          const g = grupos.find(x => x.id === gid);
          const { multiple } = reglasGrupo(g);
          const set = seleccion.get(gid);
          const oid = Number(input.value);
          if (!multiple) { set.clear(); set.add(oid); }
          else if (input.checked) set.add(oid); else set.delete(oid);
          pintar();
        });
      });
      document.getElementById('xb-mods-precio').textContent = money(precioUnitario());
      document.getElementById('xb-mods-num').textContent = String(cantidad);
      btnAgregar.disabled = !cumple();
      btnAgregar.textContent = `Agregar ${money(precioUnitario() * cantidad)}`;
    }

    return new Promise((resolve) => {
      const cerrar = (valor) => {
        dlg.close();
        document.getElementById('xb-mods-menos').onclick = null;
        document.getElementById('xb-mods-mas').onclick = null;
        btnAgregar.onclick = null;
        document.getElementById('xb-mods-cancelar').onclick = null;
        dlg.onclose = null;
        resolve(valor);
      };
      document.getElementById('xb-mods-menos').onclick = () => { cantidad = Math.max(1, cantidad - 1); pintar(); };
      document.getElementById('xb-mods-mas').onclick = () => { cantidad = Math.min(99, cantidad + 1); pintar(); };
      document.getElementById('xb-mods-cancelar').onclick = () => cerrar(null);
      dlg.onclose = () => resolve(null);
      btnAgregar.onclick = () => {
        if (!cumple()) return;
        const d = detalle();
        cerrar({
          cantidad,
          modificadores: d.map(x => x.opcion_id),
          detalle: d,
          precioUnitario: precioUnitario(),
          texto: [...new Map(d.map(x => [x.grupo, null])).keys()]
            .map(grupo => `${grupo}: ${d.filter(x => x.grupo === grupo).map(x => x.opcion).join(', ')}`).join(' · '),
        });
      };
      pintar();
      dlg.showModal();
    });
  }

  // ─── Wizard secuencial (Restaurante) ──────────────────────────────────────
  //
  // Mismo contrato de entrada y de salida que abrirModal (mismas reglas,
  // mismo cálculo de referencia, mismo objeto resuelto), pero un grupo por
  // pantalla: en hora pico el mesero lee UNA pregunta a la vez y toca una
  // opción grande, en vez de recorrer un formulario largo. Cuando el grupo
  // admite una sola opción, elegirla AVANZA sola: no hay "siguiente" que
  // tocar. Al final, un resumen con la cantidad y el total.
  //
  // POS sigue usando abrirModal: esta fase es de Restaurante y no rediseña
  // el resto de Xabor. El cálculo vive en un solo lugar (las funciones de
  // arriba) y el precio definitivo lo sigue haciendo el servidor.
  function asegurarNodoWizard() {
    let dlg = document.getElementById('xb-wiz-dlg');
    if (dlg) return dlg;
    const estilo = document.createElement('style');
    estilo.textContent = `
      #xb-wiz-dlg { border:none; border-radius:16px; padding:0; width:min(520px,96vw); max-height:92dvh; color:inherit; background:transparent; }
      #xb-wiz-dlg::backdrop { background:rgba(0,0,0,.6); }
      #xb-wiz-caja { background:#fff; color:#111827; display:flex; flex-direction:column; max-height:92dvh; border-radius:16px; overflow:hidden; }
      #xb-wiz-dlg.oscuro #xb-wiz-caja { background:#1f2937; color:#f9fafb; }
      #xb-wiz-head { padding:14px 16px 10px; border-bottom:1px solid rgba(128,128,128,.28); }
      #xb-wiz-head .xb-wiz-prod { font-size:19px; font-weight:800; }
      #xb-wiz-head .xb-wiz-paso { font-size:12px; opacity:.7; margin-top:2px; text-transform:uppercase; letter-spacing:.5px; }
      #xb-wiz-head h4 { margin:10px 0 0; font-size:17px; }
      #xb-wiz-head .xb-wiz-regla { font-size:13px; opacity:.7; margin-top:2px; }
      #xb-wiz-body { padding:12px; overflow-y:auto; flex:1; display:grid; gap:8px; }
      .xb-wiz-op { display:flex; align-items:center; gap:10px; width:100%; min-height:56px; padding:12px 14px; border-radius:12px;
                   border:2px solid rgba(128,128,128,.35); background:transparent; color:inherit; font-size:16px; font-weight:600;
                   text-align:left; cursor:pointer; }
      .xb-wiz-op .xb-wiz-extra { margin-left:auto; font-size:14px; font-weight:700; opacity:.85; }
      .xb-wiz-op.elegida { border-color:#f97316; background:rgba(249,115,22,.14); }
      .xb-wiz-op.bloqueada { opacity:.4; cursor:not-allowed; }
      .xb-wiz-op .xb-wiz-tick { width:22px; flex:none; font-size:16px; color:#f97316; }
      #xb-wiz-foot { padding:12px; border-top:1px solid rgba(128,128,128,.28); display:flex; align-items:center; gap:10px; }
      #xb-wiz-foot button { min-height:52px; border-radius:12px; font-size:16px; font-weight:800; cursor:pointer; border:none; }
      #xb-wiz-atras { background:transparent; border:2px solid rgba(128,128,128,.35); color:inherit; padding:0 16px; }
      #xb-wiz-seguir { flex:1; background:#f97316; color:#fff; }
      #xb-wiz-seguir:disabled { opacity:.45; cursor:not-allowed; }
      #xb-wiz-cerrar { background:transparent; border:none; color:inherit; opacity:.65; font-weight:600; padding:0 10px; }
      .xb-wiz-res { display:grid; gap:6px; font-size:15px; }
      .xb-wiz-res .xb-wiz-lin { display:flex; gap:10px; }
      .xb-wiz-res .xb-wiz-lin b { min-width:120px; font-weight:700; opacity:.75; font-size:13px; text-transform:uppercase; letter-spacing:.4px; }
      #xb-wiz-cant { display:flex; align-items:center; gap:14px; margin-top:10px; }
      #xb-wiz-cant button { width:52px; height:52px; border-radius:12px; border:2px solid rgba(128,128,128,.4); background:transparent; color:inherit; font-size:24px; font-weight:800; cursor:pointer; }
      #xb-wiz-cant span { font-size:22px; font-weight:800; min-width:34px; text-align:center; }
      #xb-wiz-total { margin-left:auto; font-size:22px; font-weight:900; }
    `;
    document.head.appendChild(estilo);
    dlg = document.createElement('dialog');
    dlg.id = 'xb-wiz-dlg';
    dlg.innerHTML = `
      <div id="xb-wiz-caja">
        <div id="xb-wiz-head">
          <div class="xb-wiz-prod" id="xb-wiz-prod"></div>
          <div class="xb-wiz-paso" id="xb-wiz-paso"></div>
          <h4 id="xb-wiz-grupo"></h4>
          <div class="xb-wiz-regla" id="xb-wiz-regla"></div>
        </div>
        <div id="xb-wiz-body"></div>
        <div id="xb-wiz-foot">
          <button type="button" id="xb-wiz-atras">Atrás</button>
          <button type="button" id="xb-wiz-cerrar">Cancelar</button>
          <button type="button" id="xb-wiz-seguir"></button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    return dlg;
  }

  function abrirWizard(producto, opciones = {}) {
    const grupos = producto.modificadores || [];
    const dlg = asegurarNodoWizard();
    dlg.classList.toggle('oscuro', !!opciones.oscuro);
    const seleccion = new Map(grupos.map(g => [g.id, new Set()]));
    let cantidad = 1;
    let paso = 0; // 0..grupos.length-1 = grupos; grupos.length = resumen

    const precioBase = Number(producto.precio) || 0;
    const detalle = () => grupos.flatMap(g => [...seleccion.get(g.id)].map(oid => {
      const o = g.opciones.find(x => x.id === oid);
      return { grupo_id: g.id, grupo: g.nombre, opcion_id: o.id, opcion: o.nombre, precio_extra: Number(o.precio_extra) || 0 };
    }));
    const precioUnitario = () => precioBase + detalle().reduce((s, d) => s + d.precio_extra, 0);
    const grupoCumple = (g) => {
      const { minimo, maximo } = reglasGrupo(g);
      const n = seleccion.get(g.id).size;
      return n >= minimo && n <= maximo;
    };

    const $ = (id) => document.getElementById(id);
    const body = $('xb-wiz-body');

    function pintar() {
      const enResumen = paso >= grupos.length;
      $('xb-wiz-prod').textContent = producto.nombre;
      $('xb-wiz-atras').style.display = paso > 0 ? '' : 'none';
      if (enResumen) {
        $('xb-wiz-paso').textContent = 'Resumen';
        $('xb-wiz-grupo').textContent = '';
        $('xb-wiz-regla').textContent = '';
        const d = detalle();
        const porGrupo = [...new Map(d.map(x => [x.grupo, null])).keys()].map(grupo => `
          <div class="xb-wiz-lin"><b>${esc(grupo)}</b><span>${esc(d.filter(x => x.grupo === grupo)
            .map(x => x.opcion + (x.precio_extra > 0 ? ` +${money(x.precio_extra)}` : '')).join(', '))}</span></div>`).join('');
        body.innerHTML = `
          <div class="xb-wiz-res">${porGrupo || '<div class="xb-wiz-lin"><span>Sin opciones adicionales.</span></div>'}</div>
          <div id="xb-wiz-cant">
            <button type="button" id="xb-wiz-menos" aria-label="Quitar uno">−</button>
            <span id="xb-wiz-num">${cantidad}</span>
            <button type="button" id="xb-wiz-mas" aria-label="Agregar uno">+</button>
            <span id="xb-wiz-total">${money(precioUnitario() * cantidad)}</span>
          </div>`;
        $('xb-wiz-menos').onclick = () => { cantidad = Math.max(1, cantidad - 1); pintar(); };
        $('xb-wiz-mas').onclick = () => { cantidad = Math.min(99, cantidad + 1); pintar(); };
        const seguir = $('xb-wiz-seguir');
        seguir.style.display = '';
        seguir.disabled = false;
        seguir.textContent = 'Agregar a la mesa';
        return;
      }
      const g = grupos[paso];
      const { minimo, maximo, multiple } = reglasGrupo(g);
      const n = seleccion.get(g.id).size;
      $('xb-wiz-paso').textContent = `Paso ${paso + 1} de ${grupos.length}`;
      $('xb-wiz-grupo').textContent = g.nombre;
      $('xb-wiz-regla').textContent = textoRegla(g);
      body.innerHTML = (g.opciones || []).map(o => {
        const elegida = seleccion.get(g.id).has(o.id);
        const bloqueada = !elegida && multiple && n >= maximo;
        return `
          <button type="button" class="xb-wiz-op${elegida ? ' elegida' : ''}${bloqueada ? ' bloqueada' : ''}"
                  data-opcion="${o.id}" aria-pressed="${elegida}"
                  aria-label="${esc(o.nombre)}${Number(o.precio_extra) > 0 ? `, ${money(o.precio_extra)} extra` : ''}"
                  ${bloqueada ? 'disabled' : ''}>
            <span class="xb-wiz-tick">${elegida ? '✓' : ''}</span>
            <span>${esc(o.nombre)}</span>
            ${Number(o.precio_extra) > 0 ? `<span class="xb-wiz-extra">+${money(o.precio_extra)}</span>` : ''}
          </button>`;
      }).join('');
      body.querySelectorAll('.xb-wiz-op').forEach(btn => {
        btn.addEventListener('click', () => {
          const set = seleccion.get(g.id);
          const oid = Number(btn.dataset.opcion);
          if (!multiple) {
            set.clear(); set.add(oid);
            // Elegir en un grupo de una sola opción avanza solo: un toque,
            // un paso. Sin botón intermedio que confirmar.
            paso++; pintar(); return;
          }
          if (set.has(oid)) set.delete(oid); else set.add(oid);
          // Al completar el máximo del grupo ya no hay nada más que decidir
          // aquí: avanza igual que un grupo de una sola opción.
          if (set.size === maximo && maximo !== Infinity) { paso++; }
          pintar();
        });
      });
      const seguir = $('xb-wiz-seguir');
      // El botón de avanzar solo aparece cuando de verdad hace falta: en un
      // grupo obligatorio de una opción el toque ya avanza.
      const sobra = !multiple && minimo >= 1;
      seguir.style.display = sobra ? 'none' : '';
      seguir.disabled = !grupoCumple(g);
      seguir.textContent = 'Continuar';
    }

    return new Promise((resolve) => {
      const cerrar = (valor) => {
        dlg.close();
        $('xb-wiz-atras').onclick = null;
        $('xb-wiz-cerrar').onclick = null;
        $('xb-wiz-seguir').onclick = null;
        dlg.onclose = null;
        resolve(valor);
      };
      $('xb-wiz-atras').onclick = () => { paso = Math.max(0, paso - 1); pintar(); };
      $('xb-wiz-cerrar').onclick = () => cerrar(null);
      dlg.onclose = () => resolve(null);
      $('xb-wiz-seguir').onclick = () => {
        if (paso >= grupos.length) {
          const d = detalle();
          return cerrar({
            cantidad,
            modificadores: d.map(x => x.opcion_id),
            detalle: d,
            precioUnitario: precioUnitario(),
            texto: [...new Map(d.map(x => [x.grupo, null])).keys()]
              .map(grupo => `${grupo}: ${d.filter(x => x.grupo === grupo).map(x => x.opcion).join(', ')}`).join(' · '),
          });
        }
        if (!grupoCumple(grupos[paso])) return;
        paso++; pintar();
      };
      pintar();
      dlg.showModal();
    });
  }

  global.XaborModificadores = { tieneModificadores, abrirModal, abrirWizard, textoRegla };
})(window);
