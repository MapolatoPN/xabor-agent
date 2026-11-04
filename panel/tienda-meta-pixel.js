// ─── Meta Pixel de la tienda pública (XaborMetaPixel) ──────────────────────
//
// Único lugar de la tienda que habla con Meta (Facebook/Instagram). Lo cargan
// panel/tienda.html, panel/tienda-seguimiento.html y el marco
// panel/tienda-meta-pixel.html; lo único global es `XaborMetaPixel`. El panel
// de administración NO lo carga.
//
// Reglas que este archivo garantiza:
//   · Sin el ID del píxel del negocio (15 o 16 dígitos) no se inyecta
//     fbevents.js y TODAS las funciones son no-op.
//   · Al cargar no hace nada por su cuenta: solo actúa cuando la página lo
//     llama.
//   · Ninguna función lanza: un error aquí jamás interrumpe una compra.
//   · A Meta solo viajan ids de producto, nombres de platillo, cantidades,
//     montos y la sucursal. Los parámetros se arman campo por campo, así que
//     notas, persona, nombre, teléfono, dirección o correo no tienen por
//     dónde colarse aunque vengan en el renglón. Además se apagan los eventos
//     automáticos del píxel (clics de botones y metadatos de la página).
//   · El ID nunca se escribe en el HTML: va validado a fbq('init', id).
//   · El `Purchase` NO se arma aquí: lo arma el servidor desde el pedido ya
//     confirmado y lo entrega una sola vez por folio a un solo navegador
//     (POST /api/tienda/seguimiento/:token/meta-pixel/compra, ver
//     src/services/tiendaMetaPixel.js). Se manda con eventID = folio.
//   · El token de seguimiento es la llave de un pedido y nunca llega a Meta.
//     El píxel manda la URL de la página (location.href) y su referente, y la
//     URL no se puede tachar: por eso la página de seguimiento NO carga el
//     píxel. La compra que se confirma ahí se manda desde un marco oculto con
//     URL sin token (/t/<slug>/pixel, sin referente). Si la tienda se abre
//     viniendo del seguimiento o del pago, el token se tacha del referente.
(function () {
  'use strict';

  const MONEDA = 'MXN';
  const RE_ID = /^\d{15,16}$/;
  const RE_TOKEN = /^[a-f0-9]{48}$/;
  const RE_SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;
  const FBEVENTS = 'https://connect.facebook.net/en_US/fbevents.js';
  const MAX_CONTENIDOS = 200;
  const DIA = 24 * 60 * 60 * 1000;
  const VIGENCIA_PENDIENTE = 3 * DIA;            // pedido esperando su pago en línea
  const VIGENCIA_ENVIADA = 30 * DIA;             // memoria anti-duplicados
  const P_ENVIADA = 'xabor_meta_compra:';        // + ID + ':' + folio
  const P_PENDIENTE = 'xabor_meta_pendiente:';   // + token de seguimiento

  let ID = null;            // píxel activo en ESTA página; null = apagado
  let SUCURSAL = '';
  // Respaldo en memoria de la pestaña si el navegador no deja usar storage.
  const enMemoria = new Set();
  const pendientesEnMemoria = new Map();

  const activo = () => !!ID && typeof window.fbq === 'function';
  const dinero = n => Math.round((Number(n) || 0) * 100) / 100;
  const texto = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 100);
  const piezas = n => Math.max(1, parseInt(n, 10) || 1);
  const idValido = v => (typeof v === 'string' && RE_ID.test(v.trim()) ? v.trim() : null);
  const sinToken = url => String(url || '').replace(/(\/(?:seguimiento|pagar)\/)[^/?#]+/, '$1token');

  // Storage siempre envuelto: en modo privado o con datos bloqueados lanza.
  const leer = (almacen, k) => { try { return window[almacen].getItem(k); } catch (e) { return null; } };
  const escribir = (almacen, k, v) => { try { window[almacen].setItem(k, v); } catch (e) { /* sin storage */ } };
  const borrar = (almacen, k) => { try { window[almacen].removeItem(k); } catch (e) { /* sin storage */ } };

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

  // El píxel lee document.referrer al mandar cada evento. Si la página se
  // abrió desde el seguimiento o el pago, ese referente lleva el token.
  function tacharReferente() {
    const ref = String(document.referrer || '');
    const limpio = sinToken(ref);
    if (limpio === ref) return;
    try { Object.defineProperty(document, 'referrer', { configurable: true, get: () => limpio }); } catch (e) { /* */ }
  }

  // ── Arranque ──────────────────────────────────────────────────────────────
  // El código base oficial de Meta Pixel, armado solo con un ID válido. Dos
  // ajustes: fbevents.js va al <head>, y antes de `init` se apagan los
  // eventos automáticos (autoConfig) y los PageView por cambios de historial.
  function cargarPixel(id) {
    tacharReferente();
    const f = window, b = document;
    if (!f.fbq) {
      const n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      n.disablePushState = true;
      const t = b.createElement('script');
      t.async = true;
      t.src = FBEVENTS;
      b.head.appendChild(t);
    }
    f.fbq('set', 'autoConfig', false, id);
    f.fbq('init', id);
    ID = id;
  }

  function enviar(evento, params, opciones) {
    if (!activo()) return false;
    try {
      if (opciones) window.fbq('track', evento, params, opciones);
      else window.fbq('track', evento, params);
      return true;
    } catch (e) { return false; }
  }
  // Moneda y sucursal van en todos los eventos.
  const comunes = () => ({ currency: MONEDA, ...(SUCURSAL ? { sucursal: SUCURSAL } : {}) });

  // ── Tienda ────────────────────────────────────────────────────────────────
  function iniciarTienda({ pixelId, sucursal } = {}) {
    const id = idValido(pixelId);
    if (ID) return ID === id;
    if (!id) return false;
    SUCURSAL = texto(sucursal);
    cargarPixel(id);
    window.fbq('track', 'PageView');
    limpiarMarcasViejas();
    return true;
  }

  function verProducto(p) {
    if (p?.id == null || !p?.nombre) return;
    enviar('ViewContent', {
      content_ids: [String(p.id)], content_name: texto(p.nombre), content_type: 'product',
      value: dinero(p.precio), ...comunes(),
    });
  }

  // Renglón del carrito: { productoId, nombre, precio, cantidad,
  // modificadores:[{nombre, precioExtra}] } → solo lo que puede viajar. El
  // precio es el unitario con sus extras, igual que lo cobra el servidor.
  function linea(l) {
    if (l?.productoId == null || !l?.nombre) return null;
    const mods = Array.isArray(l.modificadores) ? l.modificadores : [];
    return {
      id: String(l.productoId),
      nombre: texto(l.nombre),
      precio: dinero((Number(l.precio) || 0) + mods.reduce((a, m) => a + (Number(m?.precioExtra) || 0), 0)),
      cantidad: piezas(l.cantidad),
    };
  }

  // Agregar (anterior = null) o editar un renglón. Meta no tiene evento
  // estándar para quitar, así que quitar no manda nada, y editar solo manda
  // las piezas que se sumaron (cambiar opciones no es agregar al carrito).
  function cambioEnCarrito(anterior, nueva) {
    const n = nueva ? linea(nueva) : null;
    if (!n) return;
    const a = anterior ? linea(anterior) : null;
    const cantidad = a && a.id === n.id ? n.cantidad - a.cantidad : n.cantidad;
    if (cantidad <= 0) return;
    enviar('AddToCart', {
      content_ids: [n.id], content_name: n.nombre, content_type: 'product',
      contents: [{ id: n.id, quantity: cantidad, item_price: n.precio }],
      value: dinero(n.precio * cantidad), quantity: cantidad, ...comunes(),
    });
  }

  function iniciarCheckout(lineas) {
    const ls = (Array.isArray(lineas) ? lineas : []).map(linea).filter(Boolean).slice(0, MAX_CONTENIDOS);
    if (!ls.length) return;
    enviar('InitiateCheckout', {
      content_ids: [...new Set(ls.map(l => l.id))], content_type: 'product',
      contents: ls.map(l => ({ id: l.id, quantity: l.cantidad, item_price: l.precio })),
      num_items: ls.reduce((s, l) => s + l.cantidad, 0),
      value: dinero(ls.reduce((s, l) => s + l.precio * l.cantidad, 0)), ...comunes(),
    });
  }

  // ── Purchase ──────────────────────────────────────────────────────────────
  // Un pedido queda "por reportar" (marca en localStorage con su token) en el
  // navegador que lo creó, y solo ese navegador pide la compra al servidor.
  // El servidor la entrega UNA vez por folio (POST …/meta-pixel/compra): esa
  // es la garantía entre dispositivos. La marca de enviado por píxel y folio
  // (localStorage Y sessionStorage) evita volver a pedirla al recargar.
  const claveEnviada = (id, folio) => P_ENVIADA + id + ':' + folio;
  const clavePendiente = token => P_PENDIENTE + token;
  const yaEnviada = k => enMemoria.has(k) || leer('localStorage', k) !== null || leer('sessionStorage', k) !== null;
  function marcarEnviada(k) {
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

  // Lo que manda el servidor → parámetros de Purchase, filtrados otra vez.
  function paramsCompra(c) {
    const p = c?.params || {};
    const contents = (Array.isArray(p.contents) ? p.contents : []).slice(0, MAX_CONTENIDOS)
      .filter(x => x && x.id != null)
      .map(x => ({ id: String(x.id), quantity: piezas(x.quantity), item_price: dinero(x.item_price) }));
    if (!c?.eventID || !contents.length) return null;
    const sucursal = texto(p.sucursal) || SUCURSAL;
    return {
      value: dinero(p.value), currency: MONEDA,
      content_ids: [...new Set(contents.map(x => x.id))], content_type: 'product', contents,
      num_items: contents.reduce((s, x) => s + x.quantity, 0),
      ...(sucursal ? { sucursal } : {}),
    };
  }

  // En la tienda (/t/<slug>): la URL no lleva token, se manda aquí mismo.
  function enviarCompra(compra) {
    const params = paramsCompra(compra);
    if (!activo() || !params) return false;
    const k = claveEnviada(ID, String(compra.eventID));
    if (yaEnviada(k)) return false;
    marcarEnviada(k);      // ANTES de mandar: dos sondeos cruzados no la duplican
    return enviar('Purchase', params, { eventID: String(compra.eventID) });
  }

  // En el seguimiento: la compra se manda desde un marco con URL sin token.
  // El marco es del mismo origen; aquí solo se le pasa la compra ya filtrada.
  function enviarCompraEnMarco(d) {
    const id = idValido(d?.metaPixelId);
    const slug = String(d?.slug || '');
    const params = paramsCompra(d?.compra);
    if (!id || !RE_SLUG.test(slug) || !params) return false;
    const eventID = String(d.compra.eventID);
    const k = claveEnviada(id, eventID);
    if (yaEnviada(k)) return false;
    marcarEnviada(k);
    const marco = document.createElement('iframe');
    marco.setAttribute('referrerpolicy', 'no-referrer');
    marco.setAttribute('aria-hidden', 'true');
    marco.setAttribute('tabindex', '-1');
    marco.title = 'Meta Pixel';
    marco.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;border:0;visibility:hidden';
    marco.addEventListener('load', () => {
      try { marco.contentWindow.XaborMetaPixel.compraEnMarco({ pixelId: id, eventID, params }); } catch (e) { /* */ }
    }, { once: true });
    marco.src = '/t/' + encodeURIComponent(slug) + '/pixel';
    document.body.appendChild(marco);
    return true;
  }

  // Dentro del marco /t/<slug>/pixel: init y Purchase, sin PageView. Solo
  // corre una vez y solo si de verdad está enmarcado.
  let compraDelMarco = false;
  function compraEnMarco({ pixelId, eventID, params } = {}) {
    if (compraDelMarco || window.parent === window) return false;
    const id = idValido(pixelId);
    const p = paramsCompra({ eventID, params });
    if (!id || !p) return false;
    compraDelMarco = true;
    SUCURSAL = p.sucursal || '';
    cargarPixel(id);
    return enviar('Purchase', p, { eventID: String(eventID) });
  }

  const ruta = token => '/api/tienda/seguimiento/' + encodeURIComponent(token) + '/meta-pixel';
  // GET (limitador de lectura): ID del píxel y si espera pago. Nunca trae la compra.
  async function consultar(token) {
    const r = await fetch(ruta(token), { credentials: 'same-origin' });
    return r.ok ? r.json() : null;
  }
  // POST: reclama la compra; el servidor la entrega una sola vez por folio.
  async function reclamar(token) {
    const r = await fetch(ruta(token) + '/compra', { method: 'POST', credentials: 'same-origin' });
    return r.ok ? r.json() : null;
  }

  // Revisión de un pedido que ESTE navegador creó: pregunta (GET) y reclama
  // (POST) solo cuando el pedido ya no espera su pago.
  let consultando = false;
  async function revisar(token, mandar) {
    if (consultando || !pendiente(token)) return;
    consultando = true;
    try {
      const g = await consultar(token);
      if (!g) return;                                   // falló: el siguiente sondeo reintenta
      if (!idValido(g.metaPixelId)) return quitarPendiente(token);
      if (g.pendiente) return;                          // todavía no hay compra
      const d = await reclamar(token);
      if (!d) return;
      if (d.compra) { mandar(d); quitarPendiente(token); }
      else if (!d.pendiente) quitarPendiente(token);    // cancelado, ya entregada u otro motivo
    } finally { consultando = false; }
  }

  // Tras un checkout exitoso (respuesta de POST /checkout). El que se paga al
  // recibir ya es una compra y se reporta aquí mismo; el de pago en línea
  // espera al webhook del proveedor y lo reporta la página de seguimiento.
  function pedidoCreado(respuesta) {
    const token = String(respuesta?.trackingToken || '');
    if (!activo() || !RE_TOKEN.test(token)) return;
    if (!yaEnviada(claveEnviada(ID, String(respuesta?.folio || '')))) marcarPendiente(token);
    return revisar(token, d => enviarCompra(d.compra));
  }

  // Página de seguimiento, en cada carga y en cada sondeo. Sin la marca de
  // pendiente de ESTE navegador no hace nada (ni una consulta): un
  // dispositivo que solo abre la liga nunca carga el píxel ni reclama.
  function seguimiento(token) {
    token = String(token || '');
    if (!RE_TOKEN.test(token)) return;
    return revisar(token, enviarCompraEnMarco);
  }

  // Todo lo público pasa por aquí: nada sale de este archivo como excepción,
  // ni síncrona ni de una promesa (la que se devuelve nunca rechaza).
  const seguro = fn => (...args) => {
    try {
      const r = fn(...args);
      return r && typeof r.then === 'function' ? r.then(v => v, () => undefined) : r;
    } catch (e) { return undefined; }
  };

  window.XaborMetaPixel = Object.freeze({
    iniciarTienda: seguro(iniciarTienda),
    verProducto: seguro(verProducto),
    cambioEnCarrito: seguro(cambioEnCarrito),
    iniciarCheckout: seguro(iniciarCheckout),
    pedidoCreado: seguro(pedidoCreado),
    seguimiento: seguro(seguimiento),
    compraEnMarco: seguro(compraEnMarco),
    activo: seguro(activo),
  });
})();
