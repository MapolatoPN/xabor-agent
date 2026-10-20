// Actualización automática: la parte que vive dentro de edge/.
//
// La nube avisa «existe la versión X» con su manifiesto firmado. Aquí:
//
//   1. se verifica la FIRMA del manifiesto antes de bajar nada;
//   2. se baja el paquete, siempre del mismo servidor configurado en
//      XABOR_EDGE_WS_URL (nunca de una dirección que venga en el mensaje);
//   3. el verificador del instalador comprueba tamaño, SHA-256 y rutas, y lo
//      deja en edge.nueva;
//   4. se espera a que la cola esté quieta: nada listo para imprimir, nada a
//      medio enviar y ningún trabajo recibido en los últimos segundos;
//   5. el Edge se detiene en orden y sale con CODIGO_ACTUALIZAR. Windows
//      reinicia el servicio y el lanzador aplica la versión nueva.
//
// La verificación NO está en este archivo: la hace installer/actualizador.mjs,
// que llega con el instalador y no se actualiza solo. Sin lanzador (por
// ejemplo, `node edge/index.js` a mano o un Edge instalado con la 1.1.0) no
// hay verificador y la actualización automática está apagada.
import { VERSION_EDGE } from './version.js';

export const CODIGO_ACTUALIZAR = 75;
const TIMEOUT_DESCARGA_MS = 60_000;

export function urlDelPaquete(urlNube, version) {
  const u = new URL(urlNube);
  if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol === 'ws:') u.protocol = 'http:';
  else throw new Error('la URL de la nube no es ws:// ni wss://');
  u.username = ''; u.password = '';
  u.pathname = `/edge/actualizaciones/edge-${version}.json`;
  u.search = ''; u.hash = '';
  return u.href;
}

async function descargar(url, { maxBytes, fetchImpl }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_DESCARGA_MS);
  t.unref?.();
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`la descarga respondió ${r.status}`);
    const largo = Number(r.headers.get('content-length'));
    if (largo > maxBytes) throw new Error('el paquete es más grande de lo permitido');
    const partes = [];
    let total = 0;
    for await (const trozo of r.body) {
      total += trozo.length;
      if (total > maxBytes) { ctrl.abort(); throw new Error('el paquete es más grande de lo permitido'); }
      partes.push(Buffer.from(trozo));
    }
    return Buffer.concat(partes);
  } finally {
    clearTimeout(t);
  }
}

export function crearActualizacion({
  config, logger, almacen,
  raiz = null, verificador = null,
  informar = () => {},
  alListo = async () => {},
  fetchImpl = globalThis.fetch,
  inactivoMs = 30_000,
  maxEsperaMs = 15 * 60_000,
  pasoMs = 2_000,
} = {}) {
  const clave = raiz && verificador ? verificador.leerClavePublica(raiz) : null;
  const activa = !!clave;
  let enCurso = null;
  let ultimoTrabajo = 0;

  const avisar = (estado, version, motivo = null) => {
    try { informar({ version: String(version ?? '').slice(0, 20), estado, motivo: motivo ? String(motivo).slice(0, 200) : null }); }
    catch { /* avisar a la nube nunca puede romper la actualización */ }
  };

  function colaQuieta() {
    if (Date.now() - ultimoTrabajo < inactivoMs) return false;
    if (almacen.pendientes(Date.now()).length) return false;
    const c = almacen.contarPorEstado();
    return !(c.enviando || c.en_vuelo);
  }

  async function esperarColaQuieta() {
    const limite = Date.now() + maxEsperaMs;
    while (!colaQuieta()) {
      // Pasado el tope se sigue igual: detener() espera el envío en curso y
      // la cola vive en disco, así que lo que falte sale al volver. El tope
      // evita que una impresora apagada con trabajos en reintento deje al
      // Edge esperando para siempre.
      if (Date.now() > limite) { logger.warn('actualizacion.espera.agotada', { minutos: Math.round(maxEsperaMs / 60000) }); return; }
      await new Promise((r) => setTimeout(r, pasoMs));
    }
  }

  return {
    activa,
    version: VERSION_EDGE,

    // La versión que corre se conectó con la nube: el lanzador deja de
    // tenerla a prueba.
    confirmar() {
      if (!raiz || !verificador) return;
      try {
        const antes = verificador.leerEstado(raiz).probando;
        verificador.confirmarVersion(raiz, VERSION_EDGE);
        if (antes === VERSION_EDGE) {
          logger.info('actualizacion.confirmada', { version: VERSION_EDGE });
          avisar('confirmada', VERSION_EDGE);
        }
      } catch (e) { logger.warn('actualizacion.confirmacion.fallo', { error: e.message }); }
    },

    trabajoRecibido() { ultimoTrabajo = Date.now(); },

    get enCurso() { return enCurso; },

    async ofrecida(manifiesto) {
      if (!activa) {
        logger.info('actualizacion.ignorada', { motivo: raiz ? 'sin clave pública' : 'el Edge no arrancó con el lanzador' });
        return { ok: false, motivo: 'apagada' };
      }
      if (enCurso) return { ok: false, motivo: 'ya hay una en curso' };
      const ofrecida = String(manifiesto?.version ?? '').slice(0, 20);

      let m;
      try { m = verificador.verificarManifiesto(manifiesto, clave); }
      catch (e) {
        logger.warn('actualizacion.rechazada', { version: ofrecida, motivo: e.message });
        avisar('rechazada', ofrecida, e.message);
        return { ok: false, motivo: e.message };
      }
      if (!(verificador.compararVersiones(m.version, VERSION_EDGE) > 0)) {
        return { ok: false, motivo: 'no es más nueva que la instalada' };
      }
      const estado = verificador.leerEstado(raiz);
      if (estado.rechazadas.includes(m.version)) {
        logger.info('actualizacion.ya_rechazada', { version: m.version });
        avisar('rechazada', m.version, 'ya falló antes en este equipo');
        return { ok: false, motivo: 'ya falló antes en este equipo' };
      }

      enCurso = m.version;
      try {
        const url = urlDelPaquete(config.urlNube, m.version);
        logger.info('actualizacion.descargando', { version: m.version, desde: VERSION_EDGE });
        const bytes = await descargar(url, { maxBytes: verificador.MAX_PAQUETE, fetchImpl });
        const paquete = verificador.verificarPaquete(bytes, m);
        verificador.prepararActualizacion(raiz, paquete, { versionActual: VERSION_EDGE });
        logger.info('actualizacion.preparada', { version: m.version, archivos: Object.keys(paquete.archivos).length });
        avisar('preparada', m.version);

        await esperarColaQuieta();
        logger.info('actualizacion.reiniciando', { version: m.version });
        avisar('reiniciando', m.version);
        await alListo(CODIGO_ACTUALIZAR);
        return { ok: true, version: m.version };
      } catch (e) {
        logger.error('actualizacion.fallo', { version: m.version, error: e.message });
        avisar('error', m.version, e.message);
        enCurso = null;
        return { ok: false, motivo: e.message };
      }
    },
  };
}
