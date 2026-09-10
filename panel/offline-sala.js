// FAILOVER DE SALA: cuando la nube no contesta, hablarle al Edge de la red.
//
// Vive en su propio archivo y no en `index.html` a propósito. El panel es el
// componente que mantiene vivo al restaurante: cuanto menos se le toque, mejor.
// Todo lo que hay aquí es una función pura o una llamada HTTP; el enganche en
// `apiFetch` es de tres líneas.
//
// ── La regla que gobierna todo esto ────────────────────────────────────────
// El failover se activa SOLO cuando `fetch` RECHAZA -- es decir, cuando no hubo
// respuesta de la nube. Un 4xx o un 5xx NO son un corte: son la nube diciendo
// algo, y hay que respetarlo. Confundirlos haría que un error de permisos
// mandara al mesero a operar en local y se creara una cuenta paralela.
//
// ── Por qué hay traducción y no rutas iguales ──────────────────────────────
// El Edge responde en su propio dialecto (`/local/...`), más simple que el de
// la nube. Se traduce AQUÍ, en un solo sitio y con adaptadores probados contra
// las formas reales, para que ni el panel ni el Edge tengan que conocerse.

/** Dónde buscar un Edge. El usuario puede fijarlo si su red es rara. */
export const PUERTO_EDGE = 7071;

/**
 * A qué direcciones se puede intentar llegar DESDE ESTA PÁGINA.
 *
 * Aquí manda una restricción del navegador que decide la arquitectura entera:
 * una página servida por **https** no puede hacer `fetch` a **http** — se
 * bloquea como contenido mixto, sin posibilidad de excepción por código. La
 * única salvedad del estándar es `localhost` / `127.0.0.1`, que se consideran
 * orígenes seguros.
 *
 * Consecuencia práctica en Obispado: la caja, si corre el Edge, llega por
 * `localhost` sin problema. Las dos computadoras de meseros y la de para
 * llevar NO pueden llegar a `http://192.168.x.x:7071` desde `https://xabor.mx`,
 * por más que la red esté perfecta.
 *
 * Por eso el mismo origen va PRIMERO: cuando el navegador abre el panel que
 * sirve el propio Edge (`http://<edge>:7071/`), todo es del mismo origen y no
 * hay contenido mixto que valga. Ese es el modo local de las demás estaciones.
 */
export function candidatosDeEdge({ guardado = null, host = null, origen = null, protocolo = 'http:' } = {}) {
  const lista = [];
  const seguro = protocolo === 'https:';

  // 1. El propio origen. Si esta página la sirvió el Edge, esto acierta y
  //    ninguna otra alternativa hace falta.
  if (origen) lista.push(origen);

  const usable = (url) => !seguro || /^https:/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(url);

  for (const u of [guardado, host ? `http://${host}:${PUERTO_EDGE}` : null, `http://localhost:${PUERTO_EDGE}`]) {
    if (u && usable(u)) lista.push(u);
  }
  return [...new Set(lista)];
}

/**
 * ¿Hay un Edge en la red al que esta página NO puede llegar por la regla de
 * contenido mixto? Se detecta por deducción, no por el error: un `fetch`
 * bloqueado rechaza con el mismo `TypeError` que uno que no encontró a nadie.
 * Si lo sabemos de antemano, se le puede decir al usuario qué hacer en vez de
 * dejarle un "sin conexión" sin salida.
 */
export function bloqueadoPorNavegador({ guardado = null, protocolo = 'http:' } = {}) {
  if (protocolo !== 'https:' || !guardado) return null;
  if (/^https:/.test(guardado) || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(guardado)) return null;
  return guardado;   // hay un Edge conocido, pero por ahí no se llega
}

/**
 * ¿Hay un Edge vivo, y es el de MI negocio? Lo segundo importa: dos negocios
 * en el mismo edificio compartiendo wifi no pueden acabar operando uno en la
 * sala del otro. Sin `negocioId` esperado no se acepta ningún Edge.
 */
export async function descubrirEdge(candidatos, { negocioId, fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  if (!negocioId) return null;
  for (const base of candidatos) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetchImpl(`${base}/local/salud`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const d = await r.json();
      if (d?.ok && d.negocioId === negocioId) return { base, salud: d };
    } catch { /* ese candidato no responde; se prueba el siguiente */ }
  }
  return null;
}

// ─── Traducción de rutas ────────────────────────────────────────────────────
// Solo la operación de sala. Todo lo demás (reportes, configuración, menú,
// WhatsApp) NO tiene equivalente local y debe seguir fallando: es preferible
// que el panel diga "sin conexión" a que finja.
const RUTAS = [
  { re: /^\/api\/restaurante\/mesas$/, metodo: 'GET', local: () => '/local/mesas', adaptar: 'mesas' },
  { re: /^\/api\/restaurante\/mesas\/abrir$/, metodo: 'POST', local: () => '/local/mesas/abrir', adaptar: 'abrir' },
  { re: /^\/api\/restaurante\/cuentas\/([^/?]+)$/, metodo: 'GET', local: (m) => `/local/cuentas/${m[1]}`, adaptar: 'cuenta' },
  { re: /^\/api\/restaurante\/cuentas\/([^/?]+)\/items$/, metodo: 'POST', local: (m) => `/local/cuentas/${m[1]}/items`, adaptar: 'items' },
  { re: /^\/api\/restaurante\/cuentas\/([^/?]+)\/comanda$/, metodo: 'POST', local: (m) => `/local/cuentas/${m[1]}/comanda`, adaptar: 'comanda' },
  { re: /^\/api\/restaurante\/cuentas\/([^/?]+)\/items\/([^/?]+)\/cancelar$/, metodo: 'POST', local: (m) => `/local/cuentas/${m[1]}/items/${m[2]}/cancelar`, adaptar: 'cancelar' },
  { re: /^\/api\/restaurante\/cuentas\/([^/?]+)\/pagos$/, metodo: 'POST', local: (m) => `/local/cuentas/${m[1]}/pagos`, adaptar: 'pago' },
  { re: /^\/api\/restaurante\/cuentas\/([^/?]+)\/cerrar$/, metodo: 'POST', local: (m) => `/local/cuentas/${m[1]}/cerrar`, adaptar: 'cerrar' },
];

export function traducirRuta(url, metodo = 'GET') {
  const ruta = String(url || '').split('?')[0];
  for (const r of RUTAS) {
    if (r.metodo !== metodo.toUpperCase()) continue;
    const m = r.re.exec(ruta);
    if (m) return { local: r.local(m), adaptar: r.adaptar };
  }
  return null;
}

// ─── Adaptadores ────────────────────────────────────────────────────────────
// Convierten la respuesta del Edge en la forma EXACTA que ya espera el panel.
// Si estas funciones se equivocan, el panel se rompe justo durante el corte,
// que es cuando nadie puede depurarlo: por eso tienen prueba de contrato
// contra las formas reales de la nube (fase-sala-failover).

/** El tablero: la nube devuelve TODAS las mesas, ocupadas y libres. */
export function adaptarMesas(local) {
  const numMesas = Number(local?.numMesas) || 0;
  const porMesa = new Map((local?.ocupadas || []).map((c) => [c.mesa, c]));
  const mesas = [];
  for (let n = 1; n <= numMesas; n++) {
    const c = porMesa.get(n);
    mesas.push(c ? {
      mesa: n, ocupada: true, cuentaId: c.id, personas: c.personas,
      mesero: c.mesero?.nombre ?? null, meseroUsuarioId: c.mesero?.id ?? null,
      abiertaAt: c.abiertaAt,
      pendientes: (c.items || []).filter((i) => i.estado === 'pendiente').length,
      total: c.total, pagado: c.pagado, saldo: c.saldo,
    } : { mesa: n, ocupada: false });
  }
  return { numMesas, mesas };
}

/** `obtenerCuenta` de la nube trae dos campos que el motor local no usa. */
export function adaptarCuenta(cuenta) {
  if (!cuenta) return null;
  return {
    ...cuenta,
    notas: cuenta.notas ?? null,
    contabilizadaAt: cuenta.contabilizadaAt ?? null,
    // Marca para que la interfaz pueda avisar que esa mesa nació sin enlace.
    sinConexion: true,
  };
}

const ADAPTADORES = {
  mesas: (d) => adaptarMesas(d),
  abrir: (d) => ({ ok: true, cuenta: d.cuenta }),
  cuenta: (d) => adaptarCuenta(d.cuenta),
  items: (d) => ({ ok: true, items: d.items, cuenta: adaptarCuenta(d.cuenta) }),
  comanda: (d) => ({ ok: true, comanda: d.comanda }),
  cancelar: (d) => ({ ok: true, item: d.item, cuenta: adaptarCuenta(d.cuenta) }),
  pago: (d) => ({ ok: true, ...d.pago, cuenta: adaptarCuenta(d.cuenta) }),
  cerrar: (d) => ({ ...d }),
};

export function adaptar(nombre, datos) {
  const fn = ADAPTADORES[nombre];
  return fn ? fn(datos || {}) : datos;
}

// ─── Cliente ────────────────────────────────────────────────────────────────

export function crearClienteOffline({ base, token = null, fetchImpl = fetch } = {}) {
  let sesion = token;
  return {
    get token() { return sesion; },
    async abrirSesion(meseroId, pin) {
      const r = await fetchImpl(`${base}/local/sesion`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meseroId, pin }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: d.error || 'PIN incorrecto' };
      sesion = d.token;
      return { ok: true, mesero: d.mesero, token: d.token };
    },
    async catalogo() {
      const r = await fetchImpl(`${base}/local/catalogo`, { headers: cabeceras(sesion) });
      return r.ok ? r.json() : null;
    },
    /**
     * Ejecuta contra el Edge una llamada pensada para la nube. Devuelve algo
     * con la misma pinta que un `Response` porque quien llama —`apiFetch`—
     * hace `r.ok`, `r.status` y `r.json()` sin saber de dónde vino.
     */
    async llamar(url, opts = {}) {
      const metodo = (opts.method || 'GET').toUpperCase();
      const destino = traducirRuta(url, metodo);
      if (!destino) return null;   // esta ruta no existe sin enlace
      const r = await fetchImpl(base + destino.local, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', ...cabeceras(sesion) },
        body: metodo === 'GET' ? undefined : (opts.body || '{}'),
      });
      const datos = await r.json().catch(() => ({}));
      const cuerpo = r.ok ? adaptar(destino.adaptar, datos) : datos;
      return respuestaSimulada(r.status, cuerpo);
    },
  };
}

function cabeceras(token) { return token ? { Authorization: `Bearer ${token}` } : {}; }

// ─── Arranque en el navegador ───────────────────────────────────────────────
// Se expone en `window` para que `apiFetch` —que es un script clásico, no un
// módulo— pueda usarlo con un solo `?.`. Todo lo de arriba sigue siendo
// importable y probable desde Node sin tocar el DOM.
export function instalarEnVentana(ventana, { negocioId = null, almacen = null } = {}) {
  let cliente = null;
  let buscando = null;
  let ultimoIntento = 0;

  const leer = (k) => { try { return almacen?.getItem(k) ?? null; } catch { return null; } };
  const escribir = (k, v) => { try { almacen?.setItem(k, v); } catch { /* modo privado */ } };

  async function asegurarCliente() {
    if (cliente) return cliente;
    // No se reintenta el descubrimiento en cada llamada fallida: si la nube se
    // cayó, van a llover peticiones y sondear la red en todas dejaría la
    // pantalla congelada.
    if (Date.now() - ultimoIntento < 10000) return null;
    if (buscando) return buscando;
    ultimoIntento = Date.now();
    buscando = (async () => {
      const loc = ventana.location || {};
      const guardado = leer('xabor_edge_base');
      const found = await descubrirEdge(
        candidatosDeEdge({ guardado, host: loc.hostname, origen: loc.origin, protocolo: loc.protocol }),
        { negocioId: negocioId || leer('xabor_negocio_id') }
      );
      buscando = null;
      if (!found) {
        // Si sabemos que hay un Edge y que el navegador no nos deja llegar,
        // se avisa con la dirección exacta a la que hay que ir. Dejar solo
        // "sin conexión" sería condenar a la estación a no operar teniendo el
        // Edge a dos metros.
        const bloqueado = bloqueadoPorNavegador({ guardado, protocolo: loc.protocol });
        if (bloqueado) avisar('xabor:edge-bloqueado', { base: bloqueado });
        return null;
      }
      escribir('xabor_edge_base', found.base);
      cliente = crearClienteOffline({ base: found.base, token: leer('xabor_edge_token') });
      avisar('xabor:sin-conexion', found.salud);
      return cliente;
    })();
    return buscando;
  }

  function avisar(nombre, detalle) {
    try { ventana.dispatchEvent?.(new ventana.CustomEvent(nombre, { detail: detalle })); }
    catch { /* sin CustomEvent (pruebas): el aviso es opcional */ }
  }

  const api = {
    get base() { return cliente ? leer('xabor_edge_base') : null; },
    get disponible() { return !!cliente; },
    /** Lo que llama `apiFetch` cuando la nube no respondió. null = que falle. */
    async intentar(url, opts) {
      const c = await asegurarCliente();
      if (!c) return null;
      try { return await c.llamar(url, opts); }
      catch { return null; }   // ni el Edge contesta: que el panel diga la verdad
    },
    async abrirSesion(meseroId, pin) {
      const c = await asegurarCliente();
      if (!c) return { ok: false, error: 'No hay un equipo Xabor Edge en esta red' };
      const r = await c.abrirSesion(meseroId, pin);
      if (r.ok) escribir('xabor_edge_token', r.token);
      return r;
    },
    async catalogo() { const c = await asegurarCliente(); return c ? c.catalogo() : null; },
    olvidar() { cliente = null; ultimoIntento = 0; },
  };
  ventana.XaborOffline = api;
  return api;
}

if (typeof window !== 'undefined' && !window.XaborOffline) {
  try {
    instalarEnVentana(window, { almacen: window.localStorage });
  } catch { /* si esto falla, el panel sigue funcionando con la nube */ }
}

export function respuestaSimulada(status, cuerpo) {
  const texto = JSON.stringify(cuerpo ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    // `desdeEdge` deja rastro para que la interfaz pueda mostrar "sin conexión"
    // y para que un reporte posterior sepa qué se hizo en local.
    desdeEdge: true,
    json: async () => JSON.parse(texto),
    text: async () => texto,
    clone() { return respuestaSimulada(status, cuerpo); },
  };
}
