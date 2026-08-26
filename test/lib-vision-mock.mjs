// Mock de la API de Anthropic para Vision V1. Distinto de
// lib-anthropic-mock.mjs (cola de textos, siempre 200, pensado para el
// Asistente Comercial): las pruebas de visión necesitan además códigos de
// error (429/500), retrasos (timeout), y el registro completo de cada
// request -- cuerpo Y headers -- para poder afirmar qué se envió (schema,
// prompt, imagen) y que la API key jamás se filtre a ninguna salida.
// El SDK del proyecto apunta aquí vía ANTHROPIC_BASE_URL; ninguna prueba
// toca la API real ni gasta dinero.
import { createServer } from 'http';

/** Respuesta bien formada del proveedor para un análisis dado. */
export function respuestaDeAnalisis(analisis, { inputTokens = 1200, outputTokens = 180 } = {}) {
  return {
    status: 200,
    body: {
      id: 'msg_mock_vision', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: JSON.stringify(analisis) }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
}

/** Un análisis válido del caso real (flyer del combo), ajustable por campo. */
export function analisisBase(extra = {}) {
  return {
    version: 1, tipo: 'promocion', descripcion: 'Flyer promocional de comida',
    texto_visible: ['Combo focaccia + bebida', '$299'],
    productos_detectados: [{ nombre: 'focaccia', confianza: 0.87 }, { nombre: 'bebida', confianza: 0.79 }],
    precios_visibles: [{ valor: 299, moneda: 'MXN', confianza: 0.94 }],
    marca_visible: 'Nonna Maye', fecha_visible: null, vigencia_visible: null,
    requiere_validacion: true, incertidumbres: [], confianza_general: 0.89,
    ...extra,
  };
}

export async function arrancarVisionMock() {
  const requests = [];
  const estado = { responder: () => respuestaDeAnalisis(analisisBase()) };

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !/\/v1\/messages$/.test(req.url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_en_mock' } }));
    }
    let cuerpo = '';
    req.on('data', d => { cuerpo += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(cuerpo); } catch { /* se registra vacío */ }
      requests.push({ body, apiKey: req.headers['x-api-key'] || null });
      const r = estado.responder(body) || respuestaDeAnalisis(analisisBase());
      const enviar = () => {
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body ?? { type: 'error', error: { type: 'mock_error' } }));
      };
      if (r.delayMs) setTimeout(enviar, r.delayMs);
      else enviar();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        /** La suite reasigna por caso: (bodyParseado) => {status, body, delayMs} */
        set responder(fn) { estado.responder = fn; },
        cerrar: () => new Promise(r => server.close(r)),
      });
    });
  });
}
