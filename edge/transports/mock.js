// Transporte simulado. Obligatorio para las pruebas: guarda lo que se le
// manda para poder afirmar en un test que la comanda salió por la impresora
// correcta, con los bytes correctos y una sola vez.
//
// También sirve en sitio: una impresora configurada como `mock` acepta
// trabajos y no imprime nada -- útil para dejar el routing listo antes de que
// llegue el hardware.
export function crearTransporteMock({ logger } = {}) {
  const enviados = [];
  // Fallos programados por nombre de impresora, para simular una apagada sin
  // tocar la red.
  const fallosProgramados = new Map();

  return {
    nombre: 'mock',

    async enviar(config, bytes, contexto = {}) {
      const impresora = contexto.impresora || config?.nombre || '(sin nombre)';
      const programado = fallosProgramados.get(impresora);

      if (programado) {
        if (programado.veces > 0) programado.veces -= 1;
        if (programado.veces === 0) fallosProgramados.delete(impresora);
        // Un fallo 'incierto' simula que los bytes YA salieron.
        if (programado.incierto) { try { contexto.alEscribir?.(); } catch {} }
        logger?.warn('transporte.mock.fallo', { impresora, codigo: programado.codigo, jobId: contexto.jobId });
        return {
          resultado: programado.incierto ? 'incierto' : 'fallido',
          codigo: programado.codigo, detalle: programado.detalle,
        };
      }

      // Mismo contrato que el transporte real: se avisa antes de "entregar".
      try { contexto.alEscribir?.(); } catch {}

      enviados.push({
        impresora, jobId: contexto.jobId ?? null,
        bytes: Buffer.from(bytes), texto: Buffer.from(bytes).toString('latin1'),
        en: Date.now(),
      });
      logger?.debug('transporte.mock.enviado', { impresora, jobId: contexto.jobId, bytes: bytes.length });
      return { resultado: 'enviado', codigo: null, detalle: `${bytes.length} bytes (simulado)` };
    },

    // ── Ayudas para pruebas ──
    enviados,
    porImpresora(nombre) { return enviados.filter(e => e.impresora === nombre); },
    limpiar() { enviados.length = 0; fallosProgramados.clear(); },
    programarFallo(impresora, { codigo = 'ECONNREFUSED', detalle = 'simulado', veces = Infinity, incierto = false } = {}) {
      fallosProgramados.set(impresora, { codigo, detalle, veces, incierto });
    },
    quitarFallo(impresora) { fallosProgramados.delete(impresora); },
  };
}
