// ─── Google Analytics 4 de la tienda pública (XaborAnalytics) ──────────────
//
// Único lugar de la tienda que habla con Google Analytics. Lo cargan
// panel/tienda.html y panel/tienda-seguimiento.html; lo único global es
// `XaborAnalytics`.
//
// Reglas que este archivo garantiza:
//   · Sin ID de medición del negocio no se inyecta gtag.js y TODAS las
//     funciones son no-op (no cargan nada, no mandan nada).
//   · Ninguna función lanza: un error aquí jamás interrumpe una compra.
//   · A Analytics solo viajan datos de catálogo y montos. Los items se arman
//     campo por campo, así que notas, persona, nombre, teléfono, dirección o
//     correo no tienen por dónde colarse aunque vengan en el renglón.
//   · El `purchase` NO se arma aquí: lo arma el servidor desde el pedido ya
//     confirmado y lo entrega una sola vez por folio a un solo navegador
//     (POST /api/tienda/seguimiento/:token/analytics/compra, ver
//     src/services/tiendaAnalytics.js).
//   · El token de seguimiento es la llave de un pedido: se tacha de la URL
//     antes de que llegue a Analytics.
(function () {
  'use strict';

  const MONEDA = 'MXN';
  const DOMINIOS_LINKER = ['mapolato.com', 'xabor.mx'];
  const RE_ID = /^G-[A-Z0-9]+$/;
  const RE_TOKEN = /^[a-f0-9]{48}$/;
  const MAX_ITEMS = 200;                         // tope de GA4 por evento
  const DIA = 24 * 60 * 60 * 1000;
  const VIGENCIA_PENDIENTE = 3 * DIA;            // pedido esperando su pago en línea
  const VIGENCIA_ENVIADA = 30 * DIA;             // memoria anti-duplicados
  const P_ENVIADA = 'xabor_ga4_compra:';         // + ID + ':' + folio
  const P_PENDIENTE = 'xabor_ga4_pendiente:';    // + token de seguimiento
  const K_DEPURACION = 'xabor_ga4_debug';

  const ENTREGA = { domicilio: 'Entrega a domicilio', recoger: 'Recoger en sucursal' };
  const PAGO = {
    enlace_pago: 'Tarjeta en línea', efectivo: 'Efectivo',
    terminal: 'Tarjeta al recibir', transferencia: 'Transferencia',
  };

  let ID = null;                 // ID de medición activo; null = analítica apagada
  let categoriaDe = () => null;  // productoId → nombre de su categoría
  // Respaldo en memoria de la pestaña si el navegador no deja usar storage:
  // basta para el pago al recibir (se reporta en la misma página) y nunca
  // duplica, porque una página nueva no hereda nada.
  const enMemoria = new Set();
  const pendientesEnMemoria = new Map();

  const activo = () => !!ID && typeof window.gtag === 'function';
  const dinero = n => Math.round((Number(n) || 0) * 100) / 100;
  const texto = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 100);
  const sinToken = url => String(url || '').replace(/(\/seguimiento\/)[^/?#]+/, '$1token');

  function enviar(evento, params) {
    if (!activo()) return false;
    try { window.gtag('event', evento, params); return true; } catch (e) { return false; }
  }

  // Storage siempre envuelto: en modo privado o con datos bloqueados lanza.
  const leer = (almacen, k) => { try { return window[almacen].getItem(k); } catch (e) { return null; } };
  const escribir = (almacen, k, v) => { try { window[almacen].setItem(k, v); } catch (e) { /* sin storage */ } };
  const borrar = (almacen, k) => { try { window[almacen].removeItem(k); } catch (e) { /* sin storage */ } };

  // ?ga4_debug=1 marca esta pestaña para el DebugView de GA4 (se recuerda al
  // ir a la pasarela y volver al seguimiento); ?ga4_debug=0 lo apaga.
  function modoDepuracion() {
    const q = new URLSearchParams(location.search).get('ga4_debug');
    if (q === '1') escribir('sessionStorage', K_DEPURACION, '1');
    if (q === '0') borrar('sessionStorage', K_DEPURACION);
    return leer('sessionStorage', K_DEPURACION) === '1';
  }

  function limpiarMarcasViejas() {
    try {
      const ahora = Date.now();
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i) || '';
        const vigencia = k.startsWith(P_PENDIENTE) ? VIGENCIA_PENDIENTE
          : k.startsWith(P_ENVIADA) ? VIGENCIA_ENVIADA : 0;
        if (!vigencia) continue;
        const t = Number(localStorage.getItem(k));
        if (!Number.isFinite(t) || ahora - t > vigencia) localStorage.removeItem(k);
      }
    } catch (e) { /* sin storage */ }
  }

  // ── Arranque ──────────────────────────────────────────────────────────────
  // El snippet oficial de gtag.js, armado solo cuando hay un ID válido.
  function iniciar(measurementId) {
    const id = String(measurementId || '').trim();
    if (ID) return ID === id;
    if (id.length > 32 || !RE_ID.test(id)) return false;
    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag !== 'function') {
      window.gtag = function gtag() { window.dataLayer.push(arguments); };
    }
    const config = { linker: { domains: DOMINIOS_LINKER } };
    const ubicacion = sinToken(location.href);
    if (ubicacion !== location.href) config.page_location = ubicacion;
    const referente = sinToken(document.referrer);
    if (referente !== String(document.referrer || '')) config.page_referrer = referente;
    if (modoDepuracion()) config.debug_mode = true;
    window.gtag('js', new Date());
    window.gtag('config', id, config);
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
    ID = id;
    limpiarMarcasViejas();
    return true;
  }

  // ── Items ─────────────────────────────────────────────────────────────────
  function item({ id, nombre, categoria, variante, precio, cantidad }) {
    if (id == null || !nombre) return null;
    return {
      item_id: String(id),
      item_name: texto(nombre),
      ...(categoria ? { item_category: texto(categoria) } : {}),
      ...(variante ? { item_variant: texto(variante) } : {}),
      price: dinero(precio),
      quantity: Math.max(1, parseInt(cantidad, 10) || 1),
    };
  }
  // Producto del catálogo de la tienda: { id, nombre, precio, … }.
  const itemDeProducto = p => item({ id: p?.id, nombre: p?.nombre, categoria: categoriaDe(p?.id), precio: p?.precio, cantidad: 1 });
  // Renglón del carrito: { productoId, nombre, precio, cantidad, modificadores:[{nombre, precioExtra}] }.
  // Las opciones elegidas van en item_variant; el precio es el unitario con
  // sus extras, igual que lo cobra el servidor.
  function itemDeLinea(l) {
    const mods = Array.isArray(l?.modificadores) ? l.modificadores : [];
    return item({
      id: l?.productoId, nombre: l?.nombre, categoria: categoriaDe(l?.productoId),
      variante: mods.map(m => m?.nombre).filter(Boolean).join(', '),
      precio: (Number(l?.precio) || 0) + mods.reduce((a, m) => a + (Number(m?.precioExtra) || 0), 0),
      cantidad: l?.cantidad,
    });
  }
  const itemsDeLineas = lineas => (Array.isArray(lineas) ? lineas : []).map(itemDeLinea).filter(Boolean).slice(0, MAX_ITEMS);

  function eventoConItems(evento, items, extra) {
    if (!items.length) return false;
    const value = dinero(items.reduce((s, i) => s + i.price * i.quantity, 0));
    return enviar(evento, { currency: MONEDA, value, ...(extra || {}), items });
  }

  // ── Tienda ────────────────────────────────────────────────────────────────
  function iniciarTienda({ measurementId, catalogo } = {}) {
    if (ID) return ID === String(measurementId || '').trim();
    const categorias = Array.isArray(catalogo) ? catalogo : [];
    const mapa = new Map();
    for (const c of categorias) for (const p of (c?.productos || [])) if (!mapa.has(p.id)) mapa.set(p.id, c.nombre);
    categoriaDe = id => mapa.get(id) || null;
    if (!iniciar(measurementId)) return false;
    observarListas(categorias);
    return true;
  }

  // view_item_list: una vez por categoría y por visita, cuando su sección
  // entra en pantalla. Observador propio: no toca el que mueve los chips.
  function observarListas(categorias) {
    const vistas = new Set();
    const ver = c => {
      if (!c || vistas.has(c.id)) return;
      vistas.add(c.id);
      const lista = { item_list_id: 'cat-' + c.id, item_list_name: texto(c.nombre) };
      const items = (c.productos || []).map(itemDeProducto).filter(Boolean).slice(0, MAX_ITEMS)
        .map((it, index) => ({ ...it, index, ...lista }));
      if (items.length) enviar('view_item_list', { ...lista, items });
    };
    if (!('IntersectionObserver' in window)) { categorias.forEach(ver); return; }
    const porSeccion = new Map(categorias.map(c => ['cat-' + c.id, c]));
    const obs = new IntersectionObserver(entradas => {
      for (const e of entradas) {
        if (!e.isIntersecting) continue;
        ver(porSeccion.get(e.target.id));
        obs.unobserve(e.target);
      }
    }, { rootMargin: '0px 0px -30% 0px' });
    for (const id of porSeccion.keys()) {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    }
  }

  function verProducto(producto) {
    const it = itemDeProducto(producto);
    if (it) eventoConItems('view_item', [it]);
  }

  // Un solo punto para todo cambio del carrito: agregar (anterior = null),
  // quitar (nueva = null) o editar un renglón. Editar solo la cantidad manda
  // la diferencia; cambiar de opciones es quitar uno y agregar otro.
  function cambioEnCarrito(anterior, nueva) {
    const a = anterior ? itemDeLinea(anterior) : null;
    const n = nueva ? itemDeLinea(nueva) : null;
    if (a && n && a.item_id === n.item_id && a.item_variant === n.item_variant && a.price === n.price) {
      const delta = n.quantity - a.quantity;
      if (delta > 0) eventoConItems('add_to_cart', [{ ...n, quantity: delta }]);
      if (delta < 0) eventoConItems('remove_from_cart', [{ ...n, quantity: -delta }]);
      return;
    }
    if (a) eventoConItems('remove_from_cart', [a]);
    if (n) eventoConItems('add_to_cart', [n]);
  }

  const verCarrito = lineas => eventoConItems('view_cart', itemsDeLineas(lineas));
  const iniciarCheckout = lineas => eventoConItems('begin_checkout', itemsDeLineas(lineas));
  const elegirEntrega = (lineas, modalidad) => eventoConItems('add_shipping_info', itemsDeLineas(lineas),
    { shipping_tier: ENTREGA[modalidad] || texto(modalidad) });
  const elegirPago = (lineas, metodo) => eventoConItems('add_payment_info', itemsDeLineas(lineas),
    { payment_type: PAGO[metodo] || texto(metodo) });

  // ── Purchase ──────────────────────────────────────────────────────────────
  // Un pedido queda "por reportar" (marca en localStorage con su token) en el
  // navegador que lo creó, y solo ese navegador pide la compra al servidor.
  // El servidor la entrega UNA vez por folio a un solo navegador (POST
  // …/analytics/compra): esa es la garantía entre dispositivos. La marca de
  // enviado en localStorage Y sessionStorage evita, además, volver a pedirla
  // al recargar la confirmación o el seguimiento.
  const claveEnviada = folio => P_ENVIADA + ID + ':' + folio;
  const clavePendiente = token => P_PENDIENTE + token;

  function compraYaEnviada(folio) {
    const k = claveEnviada(folio);
    return enMemoria.has(k) || leer('localStorage', k) !== null || leer('sessionStorage', k) !== null;
  }
  function marcarEnviada(folio) {
    const k = claveEnviada(folio);
    enMemoria.add(k);
    escribir('localStorage', k, String(Date.now()));
    escribir('sessionStorage', k, '1');
  }
  function pendiente(token) {
    const t = Number(leer('localStorage', clavePendiente(token))) || pendientesEnMemoria.get(token) || 0;
    return t > 0 && Date.now() - t < VIGENCIA_PENDIENTE;
  }
  function marcarPendiente(token) {
    pendientesEnMemoria.set(token, Date.now());
    escribir('localStorage', clavePendiente(token), String(Date.now()));
  }
  function quitarPendiente(token) {
    pendientesEnMemoria.delete(token);
    borrar('localStorage', clavePendiente(token));
  }

  function enviarCompra(c) {
    if (!activo() || !c || !c.transaction_id || !Array.isArray(c.items) || !c.items.length) return false;
    const folio = String(c.transaction_id);
    if (compraYaEnviada(folio)) return false;
    // Se marca ANTES de mandar: dos sondeos que se crucen no lo duplican.
    marcarEnviada(folio);
    return enviar('purchase', {
      transaction_id: folio, currency: MONEDA,
      value: dinero(c.value), tax: dinero(c.tax), shipping: dinero(c.shipping),
      ...(c.coupon ? { coupon: texto(c.coupon) } : {}),
      items: c.items.slice(0, MAX_ITEMS).map(i => item({
        id: i?.item_id, nombre: i?.item_name, categoria: i?.item_category,
        variante: i?.item_variant, precio: i?.price, cantidad: i?.quantity,
      })).filter(Boolean),
    });
  }

  const rutaAnalytics = token => '/api/tienda/seguimiento/' + encodeURIComponent(token) + '/analytics';
  // GET: ID de medición y si espera pago. Nunca trae la compra.
  async function consultar(token) {
    const r = await fetch(rutaAnalytics(token), { credentials: 'same-origin' });
    return r.ok ? r.json() : null;
  }
  // POST: reclama la compra; el servidor la entrega una sola vez por folio.
  async function reclamar(token) {
    const r = await fetch(rutaAnalytics(token) + '/compra', { method: 'POST', credentials: 'same-origin' });
    return r.ok ? r.json() : null;
  }

  // Lo que dijo el servidor al reclamar un pedido que este navegador creó.
  function resolver(token, d) {
    if (!d || !pendiente(token)) return;
    if (d.compra) {
      enviarCompra(d.compra);
      quitarPendiente(token);
    } else if (!d.pendiente) {
      // Cancelado, ya entregada a otro navegador o sin nada que reportar:
      // ya no será una compra de este navegador.
      quitarPendiente(token);
    }
  }

  let consultando = false;
  async function revisarPendiente(token) {
    if (consultando || !activo() || !pendiente(token)) return;
    consultando = true;
    try { resolver(token, await reclamar(token)); } finally { consultando = false; }
  }

  // Tras un checkout exitoso (respuesta de POST /checkout). El que se paga al
  // recibir ya es una compra y se reporta aquí mismo; el de pago en línea
  // espera al webhook del proveedor y lo reporta la página de seguimiento.
  function pedidoCreado(respuesta) {
    const token = String(respuesta?.trackingToken || '');
    if (!activo() || !RE_TOKEN.test(token)) return;
    if (!compraYaEnviada(String(respuesta?.folio || ''))) marcarPendiente(token);
    return revisarPendiente(token);
  }

  // Página de seguimiento, en cada carga y en cada sondeo. La primera vez
  // pregunta al servidor el ID del negocio dueño del pedido (sin ID: nada se
  // carga); después solo reclama la compra mientras ESTE navegador tenga ese
  // pedido por reportar. Un dispositivo que solo abre la liga nunca reclama.
  let seguimientoListo = false;
  async function seguimiento(token) {
    token = String(token || '');
    if (!RE_TOKEN.test(token)) return;
    if (seguimientoListo) return revisarPendiente(token);
    if (consultando) return;
    consultando = true;
    let d = null;
    try { d = await consultar(token); } finally { consultando = false; }
    if (!d) return;                    // falló la consulta: el siguiente sondeo reintenta
    seguimientoListo = true;
    if (iniciar(d.ga4MeasurementId)) return revisarPendiente(token);
  }

  // Todo lo público pasa por aquí: nada sale de este archivo como excepción,
  // ni síncrona ni de una promesa (la que se devuelve nunca rechaza).
  const seguro = fn => (...args) => {
    try {
      const r = fn(...args);
      return r && typeof r.then === 'function' ? r.then(v => v, () => undefined) : r;
    } catch (e) { return undefined; }
  };

  window.XaborAnalytics = Object.freeze({
    iniciarTienda: seguro(iniciarTienda),
    verProducto: seguro(verProducto),
    cambioEnCarrito: seguro(cambioEnCarrito),
    verCarrito: seguro(verCarrito),
    iniciarCheckout: seguro(iniciarCheckout),
    elegirEntrega: seguro(elegirEntrega),
    elegirPago: seguro(elegirPago),
    pedidoCreado: seguro(pedidoCreado),
    seguimiento: seguro(seguimiento),
    activo: seguro(activo),
  });
})();
