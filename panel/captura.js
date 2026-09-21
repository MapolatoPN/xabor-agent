// Motor ÚNICO de captura de pedidos del panel.
//
// Por qué existe: el panel tenía DOS capturas independientes que duplicaban
// casi todo. Mostrador (`renderMenuPOS`, `posCarrito`, `agregarAlCarrito`,
// `confirmarPresencial`) y Envíos —recoger y domicilio— (`envCargarMenu`,
// `ENV_CARRITO`, `envAgregar`, `envCrearPedido`). Dos catálogos leyendo el
// mismo /api/menu, dos carritos con estructuras distintas, dos agrupaciones,
// dos construcciones de payload. Cada arreglo había que escribirlo dos veces
// y cada olvido se escondía en la copia:
//
//   · el bug de «domicilio no abre el configurador» (commit 62643f2) vivió en
//     la copia de Envíos, que recortaba `modificadores` al cargar el menú;
//   · `agotado` solo lo respetaba Envíos. En mostrador el producto agotado se
//     seguía mostrando, el operador lo capturaba, y el pedido moría en el
//     servidor con PRODUCTO_NO_DISPONIBLE: no podía vender y la pantalla no
//     le decía por qué;
//   · el catálogo de mostrador se cargaba UNA vez y no se refrescaba nunca
//     (editar el menú no se veía en la caja hasta recargar la página), y el
//     de Envíos se volvía a pedir en cada entrada a la pestaña.
//
// Aquí vive ese trabajo una sola vez. Lo que NO vive aquí es el dibujo de
// cada pantalla: mostrador es una cuadrícula por categorías con su carrito a
// la derecha y Envíos una búsqueda con resumen lateral. Son UX distintas a
// propósito y cada pantalla conserva su markup; lo compartido es el estado y
// las decisiones, que es donde se escondían los bugs.
//
// Igual que el configurador (panel/modificadores.js), este módulo evita
// capturar algo inválido, pero NO es la frontera de seguridad: el precio y
// las reglas definitivas los impone el servidor (recalcularItemsDesdeMenu /
// resolverProductoConModificadores) al crear el pedido.
(function (global) {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════
  //  CATÁLOGO — una sola lectura de /api/menu para todas las modalidades
  // ══════════════════════════════════════════════════════════════════════
  let _arbol = null;   // respuesta de /api/menu: categorías con sus productos
  let _plano = null;   // los mismos productos, aplanados (búsqueda de Envíos)
  let _firma = null;   // huella de lo que las pantallas pintan (ver `huella`)
  let _enVuelo = null; // revalidación en curso: nunca dos a la vez
  const _suscriptores = [];

  // Una sola regla de vendibilidad para TODOS los canales. `agotado` es el
  // interruptor rápido de inventario del tab Menú y el servidor ya lo
  // rechaza: una pantalla que siga ofreciendo el producto solo consigue que
  // el operador capture un pedido que no se puede crear.
  const vendible = (p) => !!p && p.disponible !== false && !p.agotado;

  const traer = () => (global.apiFetch || global.fetch)('/api/menu');

  function aplanar(arbol) {
    return (arbol || []).flatMap(c => (c.productos || []).map(p => ({
      ...p,
      precio: Number(p.precio) || 0,
      categoria_id: c.id,
      // `modificadores` viaja INTACTO: es lo que decide si el producto abre
      // configurador. Recortarlo fue la raíz del bug de domicilio.
      modificadores: p.modificadores || [],
    })));
  }

  // Huella de lo que las pantallas realmente muestran y de lo que decide el
  // configurador. Si esto no cambió, el catálogo efectivo no cambió y no hay
  // nada que repintar: `onCambio` solo se dispara cuando de verdad importa.
  function huella(arbol) {
    return JSON.stringify((arbol || []).map(c => [
      c.id, c.nombre,
      (c.productos || []).map(p => [
        p.id, p.nombre, Number(p.precio) || 0, vendible(p), p.imagen || '',
        (p.modificadores || []).map(g => [
          g.id, g.nombre, !!g.requerido, g.minimo, g.maximo,
          (g.opciones || []).map(o => [o.id, o.nombre, Number(o.precio_extra) || 0]),
        ]),
      ]),
    ]));
  }

  function aplicar(arbol) {
    const nueva = huella(arbol);
    if (nueva === _firma) return false; // nada cambió: ni repintado ni aviso
    _arbol = arbol;
    _plano = aplanar(arbol);
    _firma = nueva;
    _suscriptores.forEach(fn => { try { fn(); } catch (e) { console.error('[captura] suscriptor:', e); } });
    return true;
  }

  // Revalidar NUNCA destruye lo que ya se está sirviendo. Si la red falla o
  // el servidor responde cualquier cosa rara, la pantalla sigue con el
  // último catálogo bueno: preferimos un menú de hace un minuto a una
  // cuadrícula vacía en plena hora pico.
  function revalidar({ primera = false } = {}) {
    if (_enVuelo) return _enVuelo;
    _enVuelo = (async () => {
      try {
        const r = await traer();
        if (!r || r.ok === false) throw new Error('/api/menu respondió ' + (r && r.status));
        const arbol = await r.json();
        if (!Array.isArray(arbol)) throw new Error('/api/menu no devolvió una lista de categorías');
        aplicar(arbol);
      } catch (e) {
        console.warn('[captura] no se pudo revalidar el menú, se conserva el anterior:', e.message);
        // Si falla la primera carga se conserva null. Un [] aquí convertía
        // el fallo en un catálogo válido y las siguientes entradas a otra
        // modalidad podían quedarse mostrando vacío en vez de reintentar.
      } finally { _enVuelo = null; }
    })();
    return _enVuelo;
  }

  // Cache-first: si ya hay catálogo se devuelve YA —la pantalla pinta sin
  // esperar a la red— y la revalidación corre por detrás. Solo la primera
  // carga espera.
  async function cargar({ refrescar = false } = {}) {
    if (_arbol && _arbol.length && !refrescar) { revalidar(); return _arbol; }
    await revalidar({ primera: !_arbol });
    return _arbol || [];
  }

  const catalogo = {
    cargar,
    invalidar() { _arbol = null; _plano = null; _firma = null; },
    categorias() { return _arbol || []; },
    productos() { return _plano || []; },
    buscar(texto) {
      const q = String(texto || '').toLowerCase().trim();
      return (_plano || []).filter(p => vendible(p) && (!q || String(p.nombre).toLowerCase().includes(q)));
    },
    producto(id) {
      return (_plano || []).find(p => String(p.id) === String(id)) || null;
    },
    vendible,
    onCambio(fn) { if (typeof fn === 'function') _suscriptores.push(fn); },
  };

  // ══════════════════════════════════════════════════════════════════════
  //  LÍNEA — una sola forma para las dos capturas
  // ══════════════════════════════════════════════════════════════════════
  // La forma canónica es la que ya devuelve XaborModificadores.elegirLinea:
  // no hay traducción en el camino y por tanto no hay dónde perder un campo.
  function crearLinea(base) {
    const linea = {
      producto_id: base.producto_id ?? null,
      nombre: base.nombre,
      cantidad: Math.max(1, parseInt(base.cantidad, 10) || 1),
      precio_unitario: Number(base.precio_unitario ?? base.precio) || 0,
      modificadores: base.modificadores || [],
      detalle: base.detalle || [],
      texto: base.texto || base.textoModificadores || '',
      notas: base.notas || '',
    };
    // Compat temporal: mostrador escribía `textoModificadores` y Envíos
    // `precio`. Son alias ENUMERABLES a propósito (sobreviven a
    // JSON.stringify, que es como los leen las suites de navegador) sobre
    // los campos canónicos. Se van cuando las dos pantallas hablen el mismo
    // vocabulario; hasta entonces lo que NO hay es una segunda forma de
    // línea que mantener en sincronía.
    Object.defineProperty(linea, 'precio', {
      enumerable: true, configurable: true,
      get() { return this.precio_unitario; },
      set(v) { this.precio_unitario = Number(v) || 0; },
    });
    Object.defineProperty(linea, 'textoModificadores', {
      enumerable: true, configurable: true,
      get() { return this.texto; },
      set(v) { this.texto = String(v ?? ''); },
    });
    return linea;
  }

  // La identidad de una línea es (producto, opciones elegidas), nunca el
  // producto solo. La calcula el módulo del configurador para que no haya
  // dos reglas de agrupación.
  const firmaLinea = (linea) => global.XaborModificadores.firmaLinea(linea);

  // ══════════════════════════════════════════════════════════════════════
  //  CARRITO
  // ══════════════════════════════════════════════════════════════════════
  // Una clase, varias instancias: mostrador y envíos tienen cada uno el
  // suyo. El motor es único; el carrito NO se comparte entre modalidades —
  // lo que el operador está capturando para llevar no tiene por qué
  // aparecer en el pedido a domicilio que empieza después.
  class Carrito {
    constructor({ onCambio } = {}) {
      // `lineas` es el array que las pantallas exponen como global legado
      // (posCarrito / ENV_CARRITO): SIEMPRE se muta en el sitio, nunca se
      // reasigna, o esas referencias se quedarían apuntando a un array
      // huérfano y el carrito dejaría de repintarse.
      this.lineas = [];
      this._onCambio = typeof onCambio === 'function' ? onCambio : () => {};
    }

    _cambio() { try { this._onCambio(); } catch (e) { console.error('[captura] onCambio:', e); } }

    // Punto ÚNICO de selección de producto para las capturas del panel.
    // Devuelve null si no se agregó nada (producto no vendible, o el
    // operador canceló el configurador).
    async agregar(producto, opciones = {}) {
      if (!producto) return null;
      // Un producto agotado no entra por ninguna modalidad. Nada de esto
      // toca lo que YA está en el carrito: si se agota mientras hay un
      // pedido a medias, lo capturado se respeta y solo se bloquean las
      // adiciones nuevas.
      if (!vendible(producto)) return null;
      const elegida = await global.XaborModificadores.elegirLinea(producto, opciones);
      if (!elegida) return null;
      return this.agregarLinea(elegida);
    }

    // Alta directa de una línea ya resuelta (o de un item libre que no está
    // en el menú). Dos líneas con configuración idéntica se funden en una
    // con cantidad 2; dos con configuración distinta son dos líneas.
    agregarLinea(base) {
      const nueva = crearLinea(base);
      const firma = firmaLinea(nueva);
      const existente = this.lineas.find(l => firmaLinea(l) === firma);
      if (existente) existente.cantidad += nueva.cantidad;
      else this.lineas.push(nueva);
      this._cambio();
      return existente || nueva;
    }

    // Por índice, no por producto: el mismo producto puede estar dos veces
    // con configuraciones distintas y son líneas independientes.
    cambiarCantidad(idx, delta) {
      const linea = this.lineas[idx];
      if (!linea) return;
      linea.cantidad += delta;
      if (linea.cantidad <= 0) this.lineas.splice(idx, 1);
      this._cambio();
    }

    nota(idx, texto) {
      const linea = this.lineas[idx];
      if (!linea) return;
      linea.notas = String(texto ?? '');
      // Sin repintado: el operador está escribiendo dentro del input y
      // volver a pintarlo le quitaría el foco a media palabra.
    }

    quitar(idx) {
      if (!this.lineas[idx]) return;
      this.lineas.splice(idx, 1);
      this._cambio();
    }

    limpiar() { this.lineas.length = 0; this._cambio(); }

    subtotal() { return this.lineas.reduce((s, l) => s + l.precio_unitario * l.cantidad, 0); }
    conteo() { return this.lineas.reduce((s, l) => s + l.cantidad, 0); }

    // Payload de items para el servidor, igual para /api/pedido-presencial
    // y /api/pos/pedidos: ambos resuelven el producto contra el menú del
    // propio negocio e IGNORAN el precio que mande el frontend.
    itemsParaServidor() {
      return this.lineas.map(l => {
        // Item libre (sin producto_id): ruta manual de siempre, para lo que
        // no está en el menú. El servidor lo pasa tal cual, así que aquí sí
        // viajan nombre y precio.
        if (l.producto_id === null || l.producto_id === undefined || l.producto_id === '') {
          return { nombre: l.nombre, cantidad: l.cantidad, precio_unitario: l.precio_unitario, notas: l.notas || '' };
        }
        // Del menú: SOLO ids. Nombres, precios extra y reglas los resuelve
        // el servidor; mandar el precio desde aquí no sirve de nada y
        // esconde desajustes con el menú real.
        return {
          producto_id: l.producto_id,
          cantidad: l.cantidad,
          modificadores: l.modificadores || [],
          notas: l.notas || '',
        };
      });
    }
  }

  global.XaborCaptura = { catalogo, Carrito, crearLinea, firmaLinea, vendible };
})(window);
