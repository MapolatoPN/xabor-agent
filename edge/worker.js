// El worker: saca trabajos de la cola local, los renderiza, los manda por el
// transporte que toque y decide qué hacer con el resultado.
//
// Reglas que se cumplen aquí y que definen el comportamiento de Xabor Edge:
//
//   1. Cada trabajo es independiente. Si la impresora de bebidas está
//      apagada, la de cocina imprime igual. No hay transacción entre
//      impresoras -- no existe forma de hacer un rollback del papel.
//   2. Un fallo reintenta con espera creciente, nunca en bucle apretado.
//   3. Tras `maxIntentos` el trabajo pasa a 'agotado': deja de intentarse
//      solo, pero NO se borra ni se olvida.
//   4. Si el transporte responde `incierto` (los bytes salieron pero se
//      perdió la confirmación), NO se reintenta: reintentar podría sacar el
//      mismo platillo dos veces en cocina. Queda marcado para que lo mire
//      una persona.
//   5. Todo cambio de estado se persiste ANTES de seguir. Si el proceso muere
//      en medio, al arrancar se retoma desde el disco.
import { renderizar } from './renderers/index.js';
import { calcularEspera } from './config.js';

export function crearWorker({ almacen, transportes, config, logger, alResolver = null }) {
  let corriendo = false;
  let temporizador = null;
  let procesando = false;

  // Procesa UN trabajo de principio a fin y devuelve el resultado.
  async function procesar(trabajo) {
    const contexto = { jobId: trabajo.id, impresora: trabajo.impresoraNombre };

    // Marcar 'procesando' antes de tocar la impresora: si el proceso muere
    // justo ahora, al reiniciar veremos un trabajo a medias y no uno
    // pendiente que se mandaría otra vez sin más.
    almacen.actualizar(trabajo.id, { estado: 'procesando' });

    let bytes;
    try {
      bytes = renderizar(trabajo.documento, trabajo.payload, { ancho: trabajo.anchoColumnas || 42 });
    } catch (e) {
      // Un documento que no sabemos dibujar no mejora reintentando.
      logger?.error('worker.render.fallo', { jobId: trabajo.id, documento: trabajo.documento, error: e.message });
      const final = almacen.actualizar(trabajo.id, { estado: 'agotado', ultimoError: `render: ${e.message}`, intentos: trabajo.intentos + 1 });
      alResolver?.({ trabajo: final, resultado: 'fallido', error: `render: ${e.message}` });
      return final;
    }

    const transporte = transportes[trabajo.transporte] || transportes.mock;
    const intento = trabajo.intentos + 1;
    logger?.info('worker.intento', { jobId: trabajo.id, impresora: trabajo.impresoraNombre, transporte: trabajo.transporte, intento, bytes: bytes.length });

    let r;
    try {
      r = await transporte.enviar(
        { host: trabajo.host, puerto: trabajo.puerto, timeoutMs: config.timeoutImpresoraMs, nombre: trabajo.impresoraNombre },
        bytes, contexto
      );
    } catch (e) {
      // Un transporte no debería lanzar; si lo hace, se trata como fallo
      // normal en vez de tumbar el worker entero.
      r = { ok: false, codigo: 'TRANSPORTE_EXCEPCION', detalle: e.message };
    }

    if (r.ok) {
      const final = almacen.actualizar(trabajo.id, { estado: 'impreso', intentos: intento, ultimoError: null });
      logger?.info('worker.impreso', { jobId: trabajo.id, impresora: trabajo.impresoraNombre, intento });
      alResolver?.({ trabajo: final, resultado: 'impreso' });
      return final;
    }

    const error = `${r.codigo || 'ERROR'}: ${r.detalle || 'sin detalle'}`;

    if (r.incierto) {
      const final = almacen.actualizar(trabajo.id, { estado: 'incierto', intentos: intento, ultimoError: error });
      logger?.warn('worker.incierto', { jobId: trabajo.id, impresora: trabajo.impresoraNombre, intento, codigo: r.codigo });
      alResolver?.({ trabajo: final, resultado: 'incierto', error });
      return final;
    }

    if (intento >= config.maxIntentos) {
      const final = almacen.actualizar(trabajo.id, { estado: 'agotado', intentos: intento, ultimoError: error });
      logger?.error('worker.agotado', { jobId: trabajo.id, impresora: trabajo.impresoraNombre, intentos: intento, codigo: r.codigo });
      alResolver?.({ trabajo: final, resultado: 'fallido', error });
      return final;
    }

    const espera = calcularEspera(intento, { baseMs: config.reintentoBaseMs, maximoMs: config.reintentoMaximoMs });
    const final = almacen.actualizar(trabajo.id, {
      estado: 'fallido', intentos: intento, ultimoError: error, proximoIntentoEn: Date.now() + espera,
    });
    logger?.warn('worker.reintento', { jobId: trabajo.id, impresora: trabajo.impresoraNombre, intento, esperaMs: espera, codigo: r.codigo });
    alResolver?.({ trabajo: final, resultado: 'fallido', error });
    return final;
  }

  // Una pasada: coge todo lo que está listo AHORA y lo procesa.
  //
  // Los trabajos de impresoras distintas se procesan en paralelo (cuatro
  // impresoras deben imprimir a la vez), pero los de la MISMA impresora van
  // en serie: dos comandas simultáneas por el mismo cabezal se mezclarían en
  // el papel.
  async function pasada(ahora = Date.now()) {
    const listos = almacen.pendientes(ahora);
    if (!listos.length) return { procesados: 0 };

    const porImpresora = new Map();
    for (const t of listos) {
      const clave = t.impresoraId || t.impresoraNombre || '(sin impresora)';
      if (!porImpresora.has(clave)) porImpresora.set(clave, []);
      porImpresora.get(clave).push(t);
    }

    let procesados = 0;
    await Promise.all([...porImpresora.values()].map(async (cola) => {
      for (const trabajo of cola) {
        // Puede haber cambiado desde que se leyó la lista (por ejemplo, la
        // nube lo canceló): se relee antes de gastar papel.
        const actual = almacen.obtener(trabajo.id);
        if (!actual || !['pendiente', 'fallido'].includes(actual.estado)) continue;
        await procesar(actual);
        procesados++;
      }
    }));
    return { procesados };
  }

  async function tick() {
    if (!corriendo || procesando) return;
    procesando = true;
    try {
      await pasada();
    } catch (e) {
      logger?.error('worker.tick.error', { error: e.message });
    } finally {
      procesando = false;
      if (corriendo) {
        temporizador = setTimeout(tick, config.intervaloColaMs);
        // No mantener vivo el proceso solo por el temporizador: si todo lo
        // demás terminó, Node debe poder salir.
        temporizador.unref?.();
      }
    }
  }

  return {
    iniciar() {
      if (corriendo) return;
      corriendo = true;
      // Al arrancar, lo primero es recuperar lo que quedó a medias en el
      // disco (ver `recuperarInterrumpidos`), y después el ciclo normal.
      tick();
    },
    async detener() {
      corriendo = false;
      if (temporizador) { clearTimeout(temporizador); temporizador = null; }
      // Esperar a que termine la pasada en curso evita cortar un envío.
      while (procesando) await new Promise(r => setTimeout(r, 20));
    },
    pasada,
    procesar,
    get activo() { return corriendo; },
  };
}

// Al arrancar, cualquier trabajo que quedara en 'procesando' es de una
// ejecución anterior que murió a mitad. Se devuelve a la cola con un
// intento consumido: es la decisión conservadora frente a "asumir impreso"
// (perdería la comanda) y frente a "reintentar sin contar el intento" (podría
// dar vueltas para siempre).
export function recuperarInterrumpidos(almacen, logger) {
  let recuperados = 0;
  for (const t of almacen.todos()) {
    if (t.estado === 'procesando') {
      almacen.actualizar(t.id, {
        estado: 'fallido',
        intentos: (t.intentos || 0) + 1,
        ultimoError: 'el Edge se reinició mientras se enviaba este trabajo',
        proximoIntentoEn: 0,
      });
      recuperados++;
    }
  }
  if (recuperados) logger?.warn('worker.recuperados', { trabajos: recuperados });
  return recuperados;
}
