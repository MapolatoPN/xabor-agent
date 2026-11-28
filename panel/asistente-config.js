// ─── Asistente del restaurante, Fase 2: su tarjeta en Configuración ─────────
//
// Qué avisos recibe la sucursal, qué tan sensibles, quién los ve, el
// interruptor «Mostrar los avisos» (ensayo ↔ visible) y la lista de «No
// avisar de esto» para volver a encenderlos.
//
// Archivo aparte de index.html por la misma razón que descuento-cierre.js: el
// panel es un solo <script> donde una función con nombre repetido pisa en
// silencio a la otra. Todo vive en esta IIFE y lo único global es
// `XaborAsistenteConfig`. Todo el texto entra con textContent: nada de la base
// se pinta como HTML.
//
// Habla solo con /api/admin/asistente-restaurante/configuracion
// (src/asistenteRestaurante/rutas.js). La tarjeta aparece solo si el servidor
// dice que ESTA sesión la puede cambiar: el asistente encendido en la sucursal
// y el usuario en «Quién ve los avisos» (decisión del dueño, 27-nov-2026).
(function () {
  const RUTA = '/api/admin/asistente-restaurante/configuracion';
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const E = { cont: null, datos: null, ocupado: false };

  const pedir = (url, opts = {}) => (typeof apiFetch === 'function'
    ? apiFetch(url, opts)
    : fetch(url, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } }));

  function el(tag, props = {}, hijos = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === 'texto') n.textContent = v;
      else if (k === 'clase') n.className = v;
      else if (k in n && !k.startsWith('aria') && !k.startsWith('data')) n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const h of [].concat(hijos)) if (h) n.appendChild(typeof h === 'string' ? document.createTextNode(h) : h);
    return n;
  }

  function formato(valor, unidad) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return '—';
    const t = Math.round(n).toLocaleString('es-MX');
    if (unidad === 'pesos') return `$${t}`;
    if (unidad === '%') return `${t} %`;
    return `${t} ${unidad || ''}`.trim();
  }
  const fechaCorta = (iso) => { const f = iso ? new Date(iso) : null; return f && !isNaN(f) ? `${f.getDate()} ${MESES[f.getMonth()]}` : ''; };

  function estilos() {
    if (document.getElementById('ascfg-estilos')) return;
    const s = el('style', { id: 'ascfg-estilos' });
    s.textContent = `
.ascfg { font-size: 0.88rem; color: #1a1a1a; }
.ascfg h2 { font-size: 1.1rem; font-weight: 800; margin: 0 0 4px; }
.ascfg .ascfg-sub { font-size: 0.8rem; color: #888; margin: 0 0 16px; line-height: 1.4; }
.ascfg-bloque { border: 1px solid #e5e2da; border-radius: 12px; padding: 16px; margin-bottom: 14px; background: #fff; }
.ascfg-bloque h3 { font-size: 0.95rem; margin: 0 0 8px; }
.ascfg-pista { font-size: 0.76rem; color: #888; line-height: 1.35; }
.ascfg-grupo { margin: 12px 0 2px; font-weight: 700; font-size: 0.8rem; color: #555; }
.ascfg-fila { display: flex; align-items: flex-start; gap: 8px; margin: 6px 0; cursor: pointer; line-height: 1.35; }
.ascfg-fila input { margin-top: 2px; flex: none; }
.ascfg-num { display: grid; grid-template-columns: 1fr 110px; gap: 4px 10px; align-items: center; margin: 10px 0; }
.ascfg-num input { width: 100%; padding: 7px 10px; border: 1px solid #e5e2da; border-radius: 8px; font-size: 0.9rem; box-sizing: border-box; font-family: inherit; }
.ascfg-num .ascfg-pista { grid-column: 1 / -1; }
.ascfg-num.ascfg-ancho { grid-template-columns: 1fr 140px; }
.ascfg-prueba { background: none; border: 1px solid #1c1c1c; color: #1c1c1c; border-radius: 8px; padding: 7px 14px; font-size: 0.85rem; font-weight: 700; cursor: pointer; font-family: inherit; }
.ascfg-prueba[disabled] { opacity: 0.6; cursor: default; }
.ascfg-acciones { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 4px 0 18px; }
.ascfg-guardar { background: #1c1c1c; color: #fff; border: none; border-radius: 8px; padding: 9px 18px; font-size: 0.88rem; font-weight: 700; cursor: pointer; font-family: inherit; }
.ascfg-guardar[disabled] { opacity: 0.6; cursor: default; }
.ascfg-estado { font-size: 0.85rem; }
.ascfg-silencio { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; padding: 10px 0; border-top: 1px solid #f1f0ed; }
.ascfg-silencio:first-of-type { border-top: none; }
.ascfg-silencio button { background: none; border: 1px solid var(--color-brand, #FF6B35); color: var(--color-brand, #FF6B35); border-radius: 8px; padding: 5px 10px; font-size: 0.8rem; font-weight: 700; cursor: pointer; white-space: nowrap; font-family: inherit; }
@media (max-width: 480px) { .ascfg-num { grid-template-columns: 1fr 92px; } .ascfg-silencio { flex-direction: column; } }`;
    document.head.appendChild(s);
  }

  function decir(texto, color) {
    const n = E.cont && E.cont.querySelector('.ascfg-estado');
    if (n) { n.style.color = color || 'var(--color-text-secondary, #6B7280)'; n.textContent = texto; }
  }

  function ponerChip(modo) {
    const chip = document.getElementById('cfgst-asistente');
    if (!chip) return;
    chip.className = 'cfg-chip ' + (modo === 'visible' ? 'ok' : 'warn');
    chip.textContent = modo === 'visible' ? '✓ Visible' : '● En ensayo';
  }

  function pintar() {
    const d = E.datos;
    const c = E.cont;
    c.textContent = '';
    estilos();
    const raiz = el('div', { clase: 'ascfg' });

    raiz.appendChild(el('h2', { texto: '🤖 Asistente del restaurante' }));
    raiz.appendChild(el('p', { clase: 'ascfg-sub', texto: 'Cada mañana revisa las ventas de ayer y elige los avisos para la campanita. Aquí decides cuáles recibes, qué tan sensibles son y quién los ve.' }));

    // Estado
    const visible = d.modo === 'visible';
    raiz.appendChild(el('div', { clase: 'ascfg-bloque' }, [
      el('h3', { texto: 'Estado' }),
      el('label', { clase: 'ascfg-fila' }, [
        el('input', { type: 'checkbox', id: 'ascfg-visible', checked: visible }),
        el('span', { texto: 'Mostrar los avisos en la campanita' }),
      ]),
      el('div', {
        clase: 'ascfg-pista',
        texto: visible
          ? 'Ahora se muestran a las personas de «Quién ve los avisos».'
          : 'Ahora está en ensayo: cada mañana se guardan los avisos y nadie los ve.',
      }),
    ]));

    // Qué avisos
    const tipos = el('div', { clase: 'ascfg-bloque' }, [el('h3', { texto: 'Qué avisos quieres recibir' })]);
    for (const g of d.grupos) {
      tipos.appendChild(el('div', { clase: 'ascfg-grupo', texto: g.titulo }));
      for (const t of g.tipos) {
        tipos.appendChild(el('label', { clase: 'ascfg-fila' }, [
          el('input', { type: 'checkbox', 'data-tipo': t.tipo, checked: t.encendido }),
          el('span', { texto: t.nombre }),
        ]));
      }
    }
    raiz.appendChild(tipos);

    // Qué tan sensible
    const ajustes = el('div', { clase: 'ascfg-bloque' }, [el('h3', { texto: 'Qué tan sensible' })]);
    for (const [k, lim] of Object.entries(d.limites)) {
      const id = `ascfg-aj-${k}`;
      ajustes.appendChild(el('div', { clase: 'ascfg-num' }, [
        el('label', { htmlFor: id, texto: lim.titulo }),
        el('input', { type: 'number', id, 'data-ajuste': k, min: String(lim.min), max: String(lim.max), step: '1', inputMode: 'numeric', value: String(d.ajustes[k]) }),
        el('div', { clase: 'ascfg-pista', texto: `De siempre: ${formato(lim.def, lim.unidad)}. Entre ${formato(lim.min, lim.unidad)} y ${formato(lim.max, lim.unidad)}.` }),
      ]));
    }
    ajustes.appendChild(el('div', {
      clase: 'ascfg-pista',
      texto: 'Esto no cambia: para comparar hacen falta al menos 100 tickets por producto y 30 por grupo, un aviso no se repite en 7 días salvo que empeore, y nunca salen más de 3 al día.',
    }));
    raiz.appendChild(ajustes);

    // Quién ve
    const quien = el('div', { clase: 'ascfg-bloque' }, [
      el('h3', { texto: 'Quién ve los avisos' }),
      el('div', { clase: 'ascfg-pista', texto: 'Solo administradores de esta sucursal. Quien está en la lista también puede cambiar esta configuración.' }),
    ]);
    for (const a of d.administradores) {
      const yo = a.id === d.yo;
      const nombre = `${a.nombre || 'Sin nombre'}${a.email ? ` (${a.email})` : ''}${yo ? ' — tú' : ''}`;
      quien.appendChild(el('label', { clase: 'ascfg-fila' }, [
        el('input', { type: 'checkbox', 'data-admin': a.id, checked: a.recibe || yo, disabled: yo, title: yo ? 'No te puedes quitar: ya no podrías cambiar esta configuración.' : undefined }),
        el('span', { texto: nombre }),
      ]));
    }
    raiz.appendChild(quien);

    if (d.resumen) raiz.appendChild(bloqueResumen(d));

    raiz.appendChild(el('div', { clase: 'ascfg-acciones' }, [
      el('button', { type: 'button', clase: 'ascfg-guardar', texto: 'Guardar' }),
      el('span', { clase: 'ascfg-estado', role: 'status', 'aria-live': 'polite' }),
    ]));

    // «No avisar de esto»
    const calla = el('div', { clase: 'ascfg-bloque' }, [el('h3', { texto: 'Avisos que pediste no recibir' })]);
    if (!d.silenciados.length) {
      calla.appendChild(el('div', { clase: 'ascfg-pista', texto: 'Ninguno. Cuando pulses «No avisar de esto» en un aviso, aparecerá aquí.' }));
    } else {
      const nombreTipo = Object.fromEntries(d.grupos.flatMap((g) => g.tipos.map((t) => [t.tipo, t.nombre])));
      for (const s of d.silenciados) {
        const quienLo = [s.por ? `Lo calló ${s.por}` : 'Callado', s.creado_en ? `el ${fechaCorta(s.creado_en)}` : ''].filter(Boolean).join(' ');
        calla.appendChild(el('div', { clase: 'ascfg-silencio', 'data-silencio': s.firma }, [
          el('div', {}, [
            el('div', { texto: s.titulo || nombreTipo[s.tipo] || s.firma }),
            el('div', { clase: 'ascfg-pista', texto: `${quienLo}.` }),
          ]),
          el('button', { type: 'button', 'data-firma': s.firma, texto: 'Volver a avisar' }),
        ]));
      }
    }
    raiz.appendChild(calla);

    c.appendChild(raiz);
    ponerChip(d.modo);
  }

  // ─── Fase 3: redacción con IA y resumen por WhatsApp ─────────────────────
  const TIPO_RESUMEN = { diario: 'Diario', semanal: 'Semanal', prueba: 'Prueba' };
  const ESTADO_RESUMEN = {
    preparando: 'Preparándose', enviando: 'Enviándose', enviado: 'Enviado', fallo: 'No salió',
    incierto: 'Sin confirmar (no se reintenta)', omitido: 'Sin ventas: no se mandó',
  };
  const soloDigitos = (v) => String(v || '').replace(/\D/g, '');
  const dolares = (n) => `US$${(Math.round(Number(n || 0) * 100) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  function bloqueResumen(d) {
    const r = d.resumen;
    const L = d.limitesResumen || { topeUsd: { min: 1, max: 50 }, hora: { desde: '18:00', hasta: '23:30' } };
    const est = d.estadoResumen;
    const b = el('div', { clase: 'ascfg-bloque', id: 'ascfg-resumen' }, [
      el('h3', { texto: 'Redacción con IA y resumen por WhatsApp' }),
      el('label', { clase: 'ascfg-fila' }, [
        el('input', { type: 'checkbox', id: 'ascfg-ia', checked: r.ia === true }),
        el('span', { texto: 'Redactar los avisos y el resumen con IA' }),
      ]),
      el('div', { clase: 'ascfg-pista', texto: 'La IA ordena y explica los avisos de la mañana. Xabor revisa que cada número sea uno de sus cálculos; si algo no cuadra, sale el texto de siempre.' }),
      el('div', { clase: 'ascfg-num' }, [
        el('label', { htmlFor: 'ascfg-tope', texto: 'Tope de gasto de la IA al mes (dólares)' }),
        el('input', { type: 'number', id: 'ascfg-tope', min: String(L.topeUsd.min), max: String(L.topeUsd.max), step: '1', inputMode: 'numeric', value: String(r.topeUsd) }),
        el('div', {
          clase: 'ascfg-pista',
          texto: `Entre US$${L.topeUsd.min} y US$${L.topeUsd.max}. Al llegar al tope la IA se detiene hasta el mes siguiente y te avisa la campanita.${est ? ` Gastado este mes: ${dolares(est.gastoMesUsd)}.` : ''}`,
        }),
      ]),
      el('div', { clase: 'ascfg-num ascfg-ancho' }, [
        el('label', { htmlFor: 'ascfg-numero', texto: 'Celular que recibe el resumen' }),
        el('input', { type: 'tel', id: 'ascfg-numero', inputMode: 'numeric', autocomplete: 'off', maxLength: 16, placeholder: '10 dígitos', value: r.numero || '' }),
        el('div', { clase: 'ascfg-pista', texto: 'Un solo número por sucursal. Vacío = no se manda nada.' }),
      ]),
      el('label', { clase: 'ascfg-fila' }, [
        el('input', { type: 'checkbox', id: 'ascfg-diario', checked: r.diario === true }),
        el('span', { texto: 'Resumen diario: la venta del día contra el mismo día de la semana pasada' }),
      ]),
      el('div', { clase: 'ascfg-num ascfg-ancho' }, [
        el('label', { htmlFor: 'ascfg-hora', texto: 'Hora del resumen diario' }),
        el('input', { type: 'time', id: 'ascfg-hora', min: L.hora.desde, max: L.hora.hasta, step: '60', value: r.hora || '21:30' }),
        el('div', { clase: 'ascfg-pista', texto: `Entre las ${L.hora.desde} y las ${L.hora.hasta}. Compara hasta esa misma hora.` }),
      ]),
      el('label', { clase: 'ascfg-fila' }, [
        el('input', { type: 'checkbox', id: 'ascfg-semanal', checked: r.semanal === true }),
        el('span', { texto: 'Resumen semanal: los lunes a las 9:00, la semana pasada contra la anterior' }),
      ]),
      el('div', {
        clase: 'ascfg-pista',
        texto: `Sale con la plantilla de WhatsApp «${(d.plantilla && d.plantilla.nombre) || 'xabor_resumen_asistente_v1'}». Si Meta aún no la aprueba, el envío falla y lo avisa la campanita.`,
      }),
      el('div', { clase: 'ascfg-acciones' }, [
        el('button', { type: 'button', clase: 'ascfg-prueba', texto: 'Enviar prueba' }),
        el('span', { clase: 'ascfg-prueba-estado', role: 'status', 'aria-live': 'polite' }),
      ]),
    ]);
    if (est && Array.isArray(est.ultimos) && est.ultimos.length) {
      b.appendChild(el('div', { clase: 'ascfg-grupo', texto: 'Últimos envíos' }));
      for (const u of est.ultimos) {
        const partes = [
          `${fechaCorta(u.enviado_en || u.creado_en)} · ${TIPO_RESUMEN[u.tipo] || u.tipo}`,
          ESTADO_RESUMEN[u.estado] || u.estado,
          u.destino ? `al …${u.destino}` : '',
          u.con_ia ? 'con IA' : '',
        ].filter(Boolean).join(' · ');
        b.appendChild(el('div', { clase: 'ascfg-pista', 'data-envio': u.estado, texto: u.error && u.estado !== 'enviado' ? `${partes}: ${u.error}` : partes }));
      }
    }
    return b;
  }

  function leerResumen() {
    const c = E.cont;
    if (!c.querySelector('#ascfg-resumen')) return undefined;
    const tope = String(c.querySelector('#ascfg-tope').value).trim();
    return {
      ia: c.querySelector('#ascfg-ia').checked,
      topeUsd: /^\d+$/.test(tope) ? Number(tope) : null,
      diario: c.querySelector('#ascfg-diario').checked,
      hora: String(c.querySelector('#ascfg-hora').value || '').slice(0, 5),
      semanal: c.querySelector('#ascfg-semanal').checked,
      numero: String(c.querySelector('#ascfg-numero').value || '').trim(),
    };
  }

  function decirPrueba(texto, color) {
    const n = E.cont && E.cont.querySelector('.ascfg-prueba-estado');
    if (n) { n.style.color = color || 'var(--color-text-secondary, #6B7280)'; n.textContent = texto; }
  }

  async function enviarPrueba() {
    if (E.ocupado) return;
    const escrito = soloDigitos(E.cont.querySelector('#ascfg-numero')?.value);
    const guardado = (E.datos && E.datos.resumen && E.datos.resumen.numero) || '';
    if (!guardado) { decirPrueba('Primero escribe el número y pulsa «Guardar».', '#b91c1c'); return; }
    if (escrito && !escrito.endsWith(guardado)) { decirPrueba('Cambiaste el número: pulsa «Guardar» antes de mandar la prueba.', '#b91c1c'); return; }
    E.ocupado = true;
    const boton = E.cont.querySelector('.ascfg-prueba');
    if (boton) boton.disabled = true;
    decirPrueba('Enviando…');
    try {
      const r = await pedir(`${RUTA}/enviar-prueba`, { method: 'POST', body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { decirPrueba(d.error || 'No se pudo enviar la prueba.', '#b91c1c'); return; }
      decirPrueba(d.mensaje || (d.ok ? 'Listo.' : 'No salió.'), d.ok ? '#15803d' : '#b91c1c');
    } catch (e) {
      decirPrueba('No se pudo: revisa la conexión.', '#b91c1c');
    } finally {
      E.ocupado = false;
      const bt = E.cont.querySelector('.ascfg-prueba');
      if (bt) bt.disabled = false;
    }
  }

  function leerFormulario() {
    const c = E.cont;
    const ajustes = {};
    for (const i of c.querySelectorAll('input[data-ajuste]')) {
      const v = String(i.value).trim();
      ajustes[i.dataset.ajuste] = /^-?\d+$/.test(v) ? Number(v) : null;
    }
    const cambio = {
      modo: c.querySelector('#ascfg-visible').checked ? 'visible' : 'ensayo',
      tiposApagados: [...c.querySelectorAll('input[data-tipo]')].filter((i) => !i.checked).map((i) => i.dataset.tipo),
      ajustes,
      destinatarios: [...c.querySelectorAll('input[data-admin]')].filter((i) => i.checked).map((i) => i.dataset.admin),
    };
    const resumen = leerResumen();
    if (resumen) cambio.resumen = resumen;
    return cambio;
  }

  async function guardar() {
    if (E.ocupado) return;
    const cambio = leerFormulario();
    if (cambio.modo === 'visible' && E.datos.modo !== 'visible') {
      const n = cambio.destinatarios.length;
      if (!window.confirm(`Desde mañana los avisos se van a mostrar en la campanita a ${n === 1 ? '1 persona' : `${n} personas`}. ¿Seguro?`)) return;
    }
    E.ocupado = true;
    const boton = E.cont.querySelector('.ascfg-guardar');
    if (boton) boton.disabled = true;
    decir('Guardando…');
    try {
      const r = await pedir(RUTA, { method: 'PUT', body: JSON.stringify(cambio) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { decir(d.error || 'No se pudo guardar.', '#b91c1c'); return; }
      E.datos = d;
      pintar();
      decir('Guardado. La revisión de mañana ya lo usa.', '#15803d');
    } catch (e) {
      decir('No se pudo guardar: revisa la conexión.', '#b91c1c');
    } finally {
      E.ocupado = false;
      const b = E.cont.querySelector('.ascfg-guardar');
      if (b) b.disabled = false;
    }
  }

  async function volverAAvisar(firma) {
    if (E.ocupado) return;
    E.ocupado = true;
    try {
      const r = await pedir(`${RUTA}/volver-a-avisar`, { method: 'POST', body: JSON.stringify({ firma }) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 404) { await cargar(); decir('Ese aviso ya no estaba en la lista.'); return; }
      if (!r.ok) { decir(d.error || 'No se pudo volver a encender el aviso.', '#b91c1c'); return; }
      E.datos = d;
      pintar();
      decir('Listo: ese aviso puede volver a salir.', '#15803d');
    } catch (e) {
      decir('No se pudo: revisa la conexión.', '#b91c1c');
    } finally {
      E.ocupado = false;
    }
  }

  async function cargar() {
    const r = await pedir(RUTA);
    const d = r.ok ? await r.json().catch(() => null) : null;
    if (!d || !d.disponible) {
      E.datos = null;
      E.cont.textContent = '';
      E.cont.appendChild(el('div', { clase: 'ascfg-pista', texto: 'Esta configuración solo la cambia quien recibe los avisos del asistente en esta sucursal.' }));
      return false;
    }
    E.datos = d;
    pintar();
    return true;
  }

  /** La sección «Asistente» de Configuración (la abre cfgIr('asistente')). */
  async function abrir(cont) {
    if (!cont) return;
    if (E.cont !== cont) {
      E.cont = cont;
      cont.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b || !cont.contains(b)) return;
        if (b.classList.contains('ascfg-guardar')) guardar();
        else if (b.classList.contains('ascfg-prueba')) enviarPrueba();
        else if (b.dataset.firma) volverAAvisar(b.dataset.firma);
      });
    }
    cont.textContent = '';
    cont.appendChild(el('div', { clase: 'ascfg-pista', texto: 'Cargando…' }));
    try { await cargar(); } catch (e) {
      cont.textContent = '';
      cont.appendChild(el('div', { clase: 'ascfg-pista', texto: 'No se pudo cargar la configuración del asistente.' }));
    }
  }

  /** La portada de Configuración: muestra la tarjeta solo a quien la puede cambiar. */
  async function revisarTarjeta() {
    const tarjeta = document.getElementById('cfg-card-asistente');
    if (!tarjeta) return;
    const rol = typeof ROL !== 'undefined' ? ROL : null;
    const basico = typeof ES_BASICO !== 'undefined' && ES_BASICO;
    const modulos = typeof MODULOS !== 'undefined' && Array.isArray(MODULOS) ? MODULOS : [];
    if (rol !== 'admin' || basico || !modulos.includes('pos')) { tarjeta.style.display = 'none'; return; }
    try {
      const r = await pedir(RUTA);
      const d = r.ok ? await r.json() : null;
      if (d && d.disponible) { tarjeta.style.display = ''; ponerChip(d.modo); } else tarjeta.style.display = 'none';
    } catch (e) { tarjeta.style.display = 'none'; }
  }

  window.XaborAsistenteConfig = { abrir, revisarTarjeta, formato };
})();
