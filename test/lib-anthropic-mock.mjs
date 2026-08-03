// Servidor HTTP mínimo que simula la API de Mensajes de Anthropic
// (POST /v1/messages) para pruebas end-to-end del Asistente Comercial sin
// llamar al modelo real -- mismo criterio ya aplicado a Clip
// (fase-pagos-multiempresa.mjs) y a Meta (lib-meta-mock.mjs): nunca
// gastar dinero real ni depender de una respuesta no determinista de un
// servicio externo en una prueba automatizada.
//
// El SDK de Anthropic (`@anthropic-ai/sdk`) lee `ANTHROPIC_BASE_URL` del
// entorno automáticamente si no se le pasa `baseURL` explícito en el
// constructor -- brain.js/intentDetector.js no necesitan ningún cambio
// para apuntar aquí, basta con exportar esa variable antes de arrancar
// el servidor de prueba.
//
// Cola de respuestas: cada llamada entrante consume la siguiente función
// de la cola (en orden), que recibe el cuerpo de la request (incluye
// `system` y `messages`) y devuelve el texto de la respuesta. Esto le da
// a la prueba control total y determinista sobre la secuencia exacta de
// turnos (clasificación de intención + generación de respuesta,
// intercaladas).
import { createServer } from 'http';

export function arrancarAnthropicMock() {
  const cola = [];

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !/\/v1\/messages$/.test(req.url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_en_mock' } }));
    }
    let cuerpo = '';
    req.on('data', chunk => { cuerpo += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(cuerpo); } catch { /* cuerpo vacío o inválido */ }

      const responder = cola.shift();
      if (!responder) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'mock_sin_respuestas_encoladas' } }));
      }
      const texto = typeof responder === 'function' ? responder(payload) : responder;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_mock_' + Date.now(),
        type: 'message',
        role: 'assistant',
        model: payload.model || 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: texto }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      baseUrl: `http://localhost:${server.address().port}`,
      // Encola una respuesta (string, o función(payload)->string) para
      // la SIGUIENTE llamada entrante, en el orden en que se registran.
      encolarRespuesta: (respuesta) => { cola.push(respuesta); },
      pendientes: () => cola.length,
      detener: () => server.close(),
    }));
  });
}
